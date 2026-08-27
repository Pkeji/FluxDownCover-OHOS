import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { RssItem } from '../model/RssSubscription';

/**
 * Lightweight RSS/Atom XML parser.
 * Ported from FluxDown Cover's feed parser — extracts <item>/<entry> elements
 * with title, link, description and pubDate.
 */
export class RssParser {
  /**
   * Fetch and parse an RSS/Atom feed from a URL.
   * Returns an array of feed items sorted by date (newest first).
   */
  static async fetchAndParse(feedUrl: string): Promise<RssItem[]> {
    const session = http.createHttp();
    try {
      const resp = await session.request(feedUrl, {
        method: http.RequestMethod.GET,
        header: { 'User-Agent': 'FluxDownCover/1.0 RSS Reader' },
        expectDataType: http.HttpDataType.STRING,
        connectTimeout: 15000,
        readTimeout: 30000,
      });
      if (resp.responseCode >= 200 && resp.responseCode < 300) {
        const xml = resp.result as string;
        return RssParser.parseXml(xml);
      }
      return [];
    } catch (e) {
      return [];
    } finally {
      session.destroy();
    }
  }

  /** Parse RSS/Atom XML string into feed items. */
  static parseXml(xml: string): RssItem[] {
    const items: RssItem[] = [];
    // RSS 2.0: <item>...</item>
    const rssItems = RssParser.extractAll(xml, '<item', '</item>');
    for (const block of rssItems) {
      items.push({
        title: RssParser.extractTag(block, 'title'),
        link: RssParser.extractTag(block, 'link'),
        description: RssParser.extractTag(block, 'description'),
        pubDate: RssParser.parseDate(RssParser.extractTag(block, 'pubDate')),
      });
    }
    // Atom: <entry>...</entry>
    const atomEntries = RssParser.extractAll(xml, '<entry', '</entry>');
    for (const block of atomEntries) {
      items.push({
        title: RssParser.extractTag(block, 'title'),
        link: RssParser.extractAtomLink(block),
        description: RssParser.extractTag(block, 'summary'),
        pubDate: RssParser.parseDate(RssParser.extractTag(block, 'updated') || RssParser.extractTag(block, 'published')),
      });
    }
    items.sort((a, b) => b.pubDate - a.pubDate);
    return items;
  }

  /** Check if an item matches a keyword filter (case-insensitive). */
  static matchesFilter(item: RssItem, filter: string): boolean {
    if (!filter || filter.trim().length === 0) return true;
    const keywords = filter.toLowerCase().split(/[,\s]+/).filter(s => s.length > 0);
    const text = `${item.title} ${item.description}`.toLowerCase();
    return keywords.some(kw => text.includes(kw));
  }

  private static extractAll(xml: string, startTag: string, endTag: string): string[] {
    const results: string[] = [];
    let pos = 0;
    while (true) {
      const start = xml.indexOf(startTag, pos);
      if (start < 0) break;
      const end = xml.indexOf(endTag, start);
      if (end < 0) break;
      results.push(xml.substring(start, end + endTag.length));
      pos = end + endTag.length;
    }
    return results;
  }

  private static extractTag(block: string, tag: string): string {
    const open = `<${tag}`;
    const start = block.indexOf(open);
    if (start < 0) return '';
    // Handle attributes: <tag attr="...">...</tag>
    const gt = block.indexOf('>', start);
    if (gt < 0) return '';
    // Self-closing tag
    if (block[gt - 1] === '/') return '';
    const close = block.indexOf(`</${tag}>`, gt);
    if (close < 0) return '';
    let content = block.substring(gt + 1, close);
    // Unescape CDATA
    const cdata = content.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    if (cdata) content = cdata[1];
    // Unescape HTML entities
    content = content.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return content.trim();
  }

  private static extractAtomLink(block: string): string {
    const linkStart = block.indexOf('<link');
    if (linkStart < 0) return '';
    const linkEnd = block.indexOf('/>', linkStart);
    if (linkEnd < 0) return '';
    const linkTag = block.substring(linkStart, linkEnd + 2);
    const hrefMatch = linkTag.match(/href="([^"]*)"/);
    return hrefMatch ? hrefMatch[1] : '';
  }

  private static parseDate(dateStr: string): number {
    if (!dateStr) return Date.now();
    const ts = Date.parse(dateStr);
    return isNaN(ts) ? Date.now() : ts;
  }
}
