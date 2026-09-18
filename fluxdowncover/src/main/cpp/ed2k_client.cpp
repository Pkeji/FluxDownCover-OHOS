// ed2k_client.cpp - Minimal ED2K/eDonkey client for HarmonyOS
// Supports: link parsing, server connection, file source lookup

#include "ed2k_client.h"
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <unistd.h>
#include <netdb.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <sys/time.h>
#include <arpa/inet.h>
#include <chrono>
#include <thread>
#include <vector>
#include <string>

namespace ed2k {

// Default ED2K servers (publicly accessible)
static const char* DEFAULT_SERVERS[] = {
    "176.102.200.139",
    "91.217.242.232",
    "185.241.112.194",
    "45.133.1.151",
    nullptr
};
static const int DEFAULT_SERVER_PORT = 4661;

// ED2K protocol opcodes
#define OP_HELLO               0x01  // Server -> Client: welcome
#define OP_SEND_ID             0x00  // Server -> Client: your ID
#define OP_REQ_ID              0x01  // Client -> Server: login request
#define OP_SERVERMESSAGE       0x38
#define OP_SERVERIDENT         0x0D
#define OP_SERVERLIST          0x14
#define OP_REQ_FILE            0x08
#define OP_ANSWER_FILE         0x09
#define OP_FOUNDSOURCES        0x09
#define OP_REQSOURCES          0x0E
#define OP_ANSWERSOURCES       0x0F
#define OP_SERVSTATREQ         0x00
#define OP_SERVSTATRES         0x01
#define OP_EXTENDED_REQUEST    0x7C
#define OP_COMPRESSED          0xD0

// Client hello packet builder
static std::vector<uint8_t> BuildLoginPacket(uint32_t clientId, uint16_t tcpPort, uint16_t udpPort) {
    std::vector<uint8_t> pkt;
    // Payload
    uint8_t payload[200];
    int pos = 0;
    // Protocol version
    payload[pos++] = 0xE3;
    // Client ID (4 bytes LE)
    payload[pos++] = (clientId >> 0) & 0xFF;
    payload[pos++] = (clientId >> 8) & 0xFF;
    payload[pos++] = (clientId >> 16) & 0xFF;
    payload[pos++] = (clientId >> 24) & 0xFF;
    // TCP port
    payload[pos++] = (tcpPort >> 0) & 0xFF;
    payload[pos++] = (tcpPort >> 8) & 0xFF;
    // UDP port
    payload[pos++] = (udpPort >> 0) & 0xFF;
    payload[pos++] = (udpPort >> 8) & 0xFF;
    // Client version (eD2k 1.4.6)
    payload[pos++] = 0x00;
    payload[pos++] = 0x01;
    payload[pos++] = 0x00;
    payload[pos++] = 0x01;
    // Flags
    payload[pos++] = 0x00;
    payload[pos++] = 0x00;
    payload[pos++] = 0x00;
    payload[pos++] = 0x00;
    // Server version
    payload[pos++] = 0x00;
    payload[pos++] = 0x00;
    payload[pos++] = 0x00;
    payload[pos++] = 0x00;

    // Full packet: [0xE3] [len LE] [opcode=0x01] [payload]
    pkt.push_back(0xE3);
    int totalLen = pos + 1; // payload + opcode
    pkt.push_back(totalLen & 0xFF);
    pkt.push_back((totalLen >> 8) & 0xFF);
    pkt.push_back((totalLen >> 16) & 0xFF);
    pkt.push_back((totalLen >> 24) & 0xFF);
    pkt.push_back(0x01); // OP_REQ_ID
    pkt.insert(pkt.end(), payload, payload + pos);
    return pkt;
}

// Build file source request packet (OP_REQSOURCES = 0x0E)
static std::vector<uint8_t> BuildReqSourcesPacket(const uint8_t fileHash[16], uint32_t serverId, uint32_t fileSize) {
    std::vector<uint8_t> pkt;
    pkt.push_back(0xE3);
    // payload: hash(16) + serverId(4) + size(4)
    int totalLen = 16 + 4 + 4 + 1; // + opcode
    pkt.push_back(totalLen & 0xFF);
    pkt.push_back((totalLen >> 8) & 0xFF);
    pkt.push_back((totalLen >> 16) & 0xFF);
    pkt.push_back((totalLen >> 24) & 0xFF);
    pkt.push_back(0x0E); // OP_REQSOURCES
    pkt.insert(pkt.end(), fileHash, fileHash + 16);
    pkt.push_back((serverId >> 0) & 0xFF);
    pkt.push_back((serverId >> 8) & 0xFF);
    pkt.push_back((serverId >> 16) & 0xFF);
    pkt.push_back((serverId >> 24) & 0xFF);
    pkt.push_back((fileSize >> 0) & 0xFF);
    pkt.push_back((fileSize >> 8) & 0xFF);
    pkt.push_back((fileSize >> 16) & 0xFF);
    pkt.push_back((fileSize >> 24) & 0xFF);
    return pkt;
}

Ed2kClient::Ed2kClient() : sockfd_(-1), serverId_(0), connected_(false) {}
Ed2kClient::~Ed2kClient() { Disconnect(); }

bool Ed2kClient::ParseLink(const std::string& link, Ed2kFileInfo& info) {
    // Format: ed2k://|file|name|size|hash|/
    if (link.substr(0, 9) != "ed2k://|file|") return false;

    size_t pos = 9;
    size_t next;

    // Filename
    next = link.find('|', pos);
    if (next == std::string::npos) return false;
    info.filename = link.substr(pos, next - pos);
    pos = next + 1;

    // Size
    next = link.find('|', pos);
    if (next == std::string::npos) return false;
    info.fileSize = std::strtoll(link.substr(pos, next - pos).c_str(), nullptr, 10);
    pos = next + 1;

    // Hash (32 hex chars = 16 bytes)
    next = link.find('|', pos);
    if (next == std::string::npos) return false;
    std::string hashHex = link.substr(pos, next - pos);
    if (hashHex.length() != 32) return false;
    for (int i = 0; i < 16; i++) {
        char hex[3] = { hashHex[i*2], hashHex[i*2+1], 0 };
        info.hash[i] = (uint8_t)std::strtoul(hex, nullptr, 16);
    }

    return true;
}

bool Ed2kClient::Connect(const char* host, int port, int timeoutMs) {
    Disconnect();

    struct addrinfo hints, *res;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;

    char portStr[16];
    snprintf(portStr, sizeof(portStr), "%d", port);
    if (getaddrinfo(host, portStr, &hints, &res) != 0) return false;

    sockfd_ = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (sockfd_ < 0) { freeaddrinfo(res); return false; }

    // Set timeout
    struct timeval tv;
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    setsockopt(sockfd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(sockfd_, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

    if (connect(sockfd_, res->ai_addr, res->ai_addrlen) < 0) {
        freeaddrinfo(res);
        Disconnect();
        return false;
    }
    freeaddrinfo(res);
    connected_ = true;
    return true;
}

void Ed2kClient::Disconnect() {
    if (sockfd_ >= 0) {
        close(sockfd_);
        sockfd_ = -1;
    }
    connected_ = false;
    serverId_ = 0;
}

bool Ed2kClient::Login(uint32_t clientId) {
    if (!connected_) return false;

    // Read server greeting (OP_SEND_ID or similar)
    uint8_t buf[512];
    int n = recv(sockfd_, buf, sizeof(buf), 0);
    if (n < 5) return false;

    // Server sends: [0xE3][len][opcode][data]
    if (buf[0] != 0xE3) return false;

    // Send login packet
    auto pkt = BuildLoginPacket(clientId, 0, 0);
    if (send(sockfd_, pkt.data(), pkt.size(), 0) < 0) return false;

    // Read response
    n = recv(sockfd_, buf, sizeof(buf), 0);
    if (n < 5) return false;

    // Parse server ID from response
    if (buf[0] == 0xE3 && n >= 9) {
        serverId_ = buf[5] | (buf[6] << 8) | (buf[7] << 16) | (buf[8] << 24);
    }

    return true;
}

bool Ed2kClient::QueryFile(const uint8_t fileHash[16], uint32_t fileSize,
                           std::vector<Ed2kSource>& sources, int timeoutMs) {
    if (!connected_) return false;

    // Send file source request
    auto pkt = BuildReqSourcesPacket(fileHash, serverId_, fileSize);
    if (send(sockfd_, pkt.data(), pkt.size(), 0) < 0) return false;

    // Read response
    uint8_t buf[8192];
    auto start = std::chrono::steady_clock::now();
    while (true) {
        auto now = std::chrono::steady_clock::now();
        int elapsed = (int)std::chrono::duration_cast<std::chrono::milliseconds>(now - start).count();
        if (elapsed > timeoutMs) break;

        // Set shorter timeout for recv
        struct timeval tv;
        tv.tv_sec = 5;
        tv.tv_usec = 0;
        setsockopt(sockfd_, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        int n = recv(sockfd_, buf, sizeof(buf), 0);
        if (n < 5) break;
        if (buf[0] != 0xE3) continue;

        uint32_t pktLen = buf[1] | (buf[2] << 8) | (buf[3] << 16) | (buf[4] << 24);
        uint8_t opcode = buf[5];

        if (opcode == 0x0F) { // OP_ANSWERSOURCES
            // Parse source list
            // Format: hash(16) + count(4) + [source entries]
            int pos = 6;
            // Skip file hash (16 bytes)
            pos += 16;
            if (pos + 4 > n) break;
            uint32_t count = buf[pos] | (buf[pos+1] << 8) | (buf[pos+2] << 16) | (buf[pos+3] << 24);
            pos += 4;

            for (uint32_t i = 0; i < count && pos + 7 <= n; i++) {
                Ed2kSource src;
                // Source: IP(4) + port(2) + serverFlags(1)
                src.ip = buf[pos] | (buf[pos+1] << 8) | (buf[pos+2] << 16) | (buf[pos+3] << 24);
                src.port = buf[pos+4] | (buf[pos+5] << 8);
                pos += 7;
                // Skip next three bytes (hash verification)
                pos += 3;

                char ipStr[16];
                snprintf(ipStr, sizeof(ipStr), "%d.%d.%d.%d",
                    src.ip & 0xFF, (src.ip >> 8) & 0xFF,
                    (src.ip >> 16) & 0xFF, (src.ip >> 24) & 0xFF);
                src.ipStr = ipStr;
                sources.push_back(src);
            }
            break;
        }
    }

    return !sources.empty();
}

const char** Ed2kClient::GetDefaultServers() { return DEFAULT_SERVERS; }

} // namespace ed2k
