// ed2k_client.h - Minimal ED2K/eDonkey client
#ifndef ED2K_CLIENT_H
#define ED2K_CLIENT_H

#include <cstdint>
#include <string>
#include <vector>

namespace ed2k {

struct Ed2kFileInfo {
    std::string filename;
    int64_t fileSize;
    uint8_t hash[16];
};

struct Ed2kSource {
    uint32_t ip;
    uint16_t port;
    std::string ipStr;
};

class Ed2kClient {
public:
    Ed2kClient();
    ~Ed2kClient();

    // Parse ed2k://|file|name|size|hash|/
    static bool ParseLink(const std::string& link, Ed2kFileInfo& info);

    // Connect to ED2K server
    bool Connect(const char* host, int port, int timeoutMs = 5000);
    void Disconnect();
    bool IsConnected() const { return connected_; }

    // Login to server
    bool Login(uint32_t clientId = 12345);

    // Query file sources by hash
    bool QueryFile(const uint8_t fileHash[16], uint32_t fileSize,
                   std::vector<Ed2kSource>& sources, int timeoutMs = 15000);

    static const char** GetDefaultServers();

private:
    int sockfd_;
    uint32_t serverId_;
    bool connected_;
};

} // namespace ed2k

#endif // ED2K_CLIENT_H
