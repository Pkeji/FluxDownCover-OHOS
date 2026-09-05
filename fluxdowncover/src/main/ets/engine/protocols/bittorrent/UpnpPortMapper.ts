import { http, connection, socket } from '@kit.NetworkKit';
import { logCollector } from '../../../utils/LogCollector';
import { BusinessError } from '@kit.BasicServicesKit';
import { util } from '@kit.ArkTS';
import Url from '@ohos.url';

/**
 * UPnP Internet Gateway Device (IGD) port mapper.
 *
 * Performs automatic NAT port forwarding so that other peers can connect to
 * our listen port even behind a home router:
 *   1. SSDP M-SEARCH discovers the IGD on the LAN (239.255.255.250:1900).
 *   2. Fetch the IGD description XML to locate the WAN(IP/PPP)Connection
 *      control URL + service type.
 *   3. SOAP AddPortMapping opens the TCP port; DeletePortMapping closes it.
 *
 * Best-effort: most mobile networks are behind carrier-grade NAT where UPnP is
 * unavailable, in which case all methods reject and the caller continues with
 * DHT/tracker-based connectivity (we simply won't be reachable inbound — but
 * we can still download and upload to peers that connect to us first).
 */

const SSDP_HOST = '239.255.255.250';
const SSDP_PORT = 1900;
const SSDP_DISCOVER =
  'M-SEARCH * HTTP/1.1\r\n' +
  'HOST: 239.255.255.250:1900\r\n' +
  'MAN: "ssdp:discover"\r\n' +
  'MX: 3\r\n' +
  'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n' +
  '\r\n';
const SSDP_TIMEOUT = 4000;

interface IgdService {
  controlUrl: string; // absolute or host-relative URL
  serviceType: string; // e.g. urn:schemas-upnp-org:service:WANIPConnection:1
}

export class UpnpPortMapper {
  private mapped: { externalPort: number; protocol: string } | null = null;

  /** Map `internalPort` (TCP) to the same external port on the router. */
  async mapPort(internalPort: number, description: string = 'FluxDownCover'): Promise<boolean> {
    try {
      const igd = await this.discover();
      if (!igd) {
        return false;
      }
      const localIp = await this.getLocalIp();
      const ok = await this.addPortMapping(igd, internalPort, localIp, description);
      if (ok) {
        this.mapped = { externalPort: internalPort, protocol: 'TCP' };
      }
      return ok;
    } catch (e) {
      logCollector.warn('Warn', `FluxDown Cover UPnP map failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Remove the previously created mapping. */
  async unmapPort(): Promise<void> {
    if (!this.mapped) {
      return;
    }
    try {
      const igd = await this.discover();
      if (igd) {
        await this.deletePortMapping(igd, this.mapped.externalPort);
      }
    } catch (_) {
      // best effort
    } finally {
      this.mapped = null;
    }
  }

  // ── SSDP discovery ──────────────────────────────────────────────────────

  private async discover(): Promise<IgdService | null> {
    const udp = socket.constructUDPSocketInstance();
    let resolved = false;
    const result = await new Promise<IgdService | null>((resolve) => {
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, SSDP_TIMEOUT);

      udp.on('message', (value: socket.SocketMessageInfo) => {
        if (resolved) {
          return;
        }
        const raw = value.message;
        const text = raw instanceof ArrayBuffer ? decodeUtf8(raw) : decodeUtf8((raw as Uint8Array).buffer as ArrayBuffer);
        const location = this.extractHeader(text, 'LOCATION');
        if (location) {
          resolved = true;
          clearTimeout(timer);
          this.fetchService(location)
            .then((svc) => resolve(svc))
            .catch(() => resolve(null));
        }
      });

      udp.on('error', (err: BusinessError) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(null);
        }
      });

      udp.bind({ address: '0.0.0.0', port: 0 }, (err: BusinessError) => {
        if (err) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(null);
          }
          return;
        }
        udp.send({
          data: asciiToBytesRaw(SSDP_DISCOVER),
          address: { address: SSDP_HOST, port: SSDP_PORT }
        }).catch(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            resolve(null);
          }
        });
      });
    });
    try {
      udp.close();
    } catch (_) { /* ignore */ }
    return result;
  }

  // ── IGD description ─────────────────────────────────────────────────────

  private async fetchService(location: string): Promise<IgdService | null> {
    // Remember the IGD origin so we can resolve relative control URLs.
    try {
      const u = new Url.URL(location);
      this.igdHost = u.hostname;
      this.igdOrigin = `${u.protocol}//${u.host}`;
    } catch (_) {
      // ignore
    }
    const req = http.createHttp();
    try {
      const resp = await req.request(location, {
        method: http.RequestMethod.GET,
        header: { Accept: '*/*' },
        connectTimeout: 5000,
        readTimeout: 5000
      });
      const xml = resp.result as string;
      const services = this.parseServices(xml);
      for (const s of services) {
        const resolved = this.resolveControlUrl(s.controlUrl);
        if (s.serviceType.includes('WANIPConnection') || s.serviceType.includes('WANPPPConnection')) {
          return { serviceType: s.serviceType, controlUrl: resolved };
        }
      }
      if (services.length > 0) {
        return { serviceType: services[0].serviceType, controlUrl: this.resolveControlUrl(services[0].controlUrl) };
      }
      return null;
    } finally {
      req.destroy();
    }
  }

  /** Resolve a (possibly relative) control URL against the IGD origin. */
  private resolveControlUrl(controlUrl: string): string {
    if (controlUrl.startsWith('http://') || controlUrl.startsWith('https://')) {
      return controlUrl;
    }
    if (this.igdOrigin) {
      return controlUrl.startsWith('/') ? `${this.igdOrigin}${controlUrl}` : `${this.igdOrigin}/${controlUrl}`;
    }
    return `http://${this.igdHost}${controlUrl.startsWith('/') ? '' : '/'}${controlUrl}`;
  }

  /** Parse <service> blocks out of the IGD description XML (tolerant, no DOM). */
  private parseServices(xml: string): IgdService[] {
    const out: IgdService[] = [];
    const blocks = xml.split('<service');
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i].split('</service>')[0];
      const serviceType = this.extractTag(block, 'serviceType');
      const controlUrl = this.extractTag(block, 'controlURL');
      if (serviceType && controlUrl) {
        out.push({ serviceType, controlUrl });
      }
    }
    return out;
  }

  // ── SOAP actions ────────────────────────────────────────────────────────

  private async addPortMapping(
    svc: IgdService,
    port: number,
    internalClient: string,
    description: string
  ): Promise<boolean> {
    const body =
      '<?xml version="1.0"?>\r\n' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:AddPortMapping xmlns:u="${svc.serviceType}">` +
      '<NewRemoteHost></NewRemoteHost>' +
      `<NewExternalPort>${port}</NewExternalPort>` +
      '<NewProtocol>TCP</NewProtocol>' +
      `<NewInternalPort>${port}</NewInternalPort>` +
      `<NewInternalClient>${internalClient}</NewInternalClient>` +
      '<NewEnabled>1</NewEnabled>' +
      `<NewPortMappingDescription>${description}</NewPortMappingDescription>` +
      '<NewLeaseDuration>0</NewLeaseDuration>' +
      `</u:AddPortMapping>` +
      '</s:Body></s:Envelope>';

    const resp = await this.soap(svc, 'AddPortMapping', body);
    // UPnP returns 200 OK or a SOAP fault. Treat HTTP success as mapped.
    return resp >= 200 && resp < 300;
  }

  private async deletePortMapping(svc: IgdService, port: number): Promise<boolean> {
    const body =
      '<?xml version="1.0"?>\r\n' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      '<s:Body>' +
      `<u:DeletePortMapping xmlns:u="${svc.serviceType}">` +
      '<NewRemoteHost></NewRemoteHost>' +
      `<NewExternalPort>${port}</NewExternalPort>` +
      '<NewProtocol>TCP</NewProtocol>' +
      `</u:DeletePortMapping>` +
      '</s:Body></s:Envelope>';
    const resp = await this.soap(svc, 'DeletePortMapping', body);
    return resp >= 200 && resp < 300;
  }

  private async soap(svc: IgdService, action: string, body: string): Promise<number> {
    const url = svc.controlUrl; // already resolved to absolute in fetchService
    const req = http.createHttp();
    try {
      const resp = await req.request(url, {
        method: http.RequestMethod.POST,
        header: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${svc.serviceType}#${action}"`,
          Accept: '*/*'
        },
        extraData: body,
        connectTimeout: 5000,
        readTimeout: 5000
      });
      return resp.responseCode ?? 0;
    } finally {
      req.destroy();
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private igdHost: string = '192.168.0.1';
  private igdOrigin: string = '';

  private extractHeader(text: string, name: string): string | null {
    const lines = text.split('\r\n');
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx <= 0) {
        continue;
      }
      if (line.substring(0, idx).trim().toUpperCase() === name.toUpperCase()) {
        return line.substring(idx + 1).trim();
      }
    }
    return null;
  }

  private extractTag(block: string, tag: string): string | null {
    const open = block.indexOf(`<${tag}>`);
    const close = block.indexOf(`</${tag}>`);
    if (open < 0 || close < 0 || close < open) {
      return null;
    }
    return block.substring(open + tag.length + 2, close).trim();
  }

  /** Best-effort local LAN IP via the network connection API. */
  private async getLocalIp(): Promise<string> {
    try {
      const netHandle = connection.getDefaultNetSync();
      const props = await connection.getConnectionProperties(netHandle);
      const addrs = props.linkAddresses ?? [];
      for (const la of addrs) {
        // LinkAddress.address is a NetAddress object ({ address: string, port: number })
        const netAddr = la.address as { address?: string; port?: number };
        const addr: string = netAddr?.address ?? '';
        if (addr && addr.indexOf('.') >= 0 && !addr.startsWith('127.')) {
          return addr.split('/')[0];
        }
      }
    } catch (_) {
      // ignore
    }
    return '0.0.0.0';
  }
}

/** Convert an ASCII string to a raw Uint8Array (for SSDP UDP payload). */
function asciiToBytesRaw(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    u[i] = s.charCodeAt(i) & 0xff;
  }
  return u;
}

/** Decode a raw UDP payload to a UTF-8 string (SSDP M-SEARCH responses). */
function decodeUtf8(buf: ArrayBuffer): string {
  const decoder = util.TextDecoder.create('utf-8', { ignoreBOM: true });
  return decoder.decodeToString(new Uint8Array(buf));
}
