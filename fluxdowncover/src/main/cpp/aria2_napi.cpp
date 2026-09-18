#include <napi/native_api.h>
#include <string>
#include <vector>
#include <thread>
#include <atomic>
#include <chrono>
#include <cstdio>

// aria2 C API (静态链接)
#include "aria2.h"
#include "hilog/log.h"
#include "ed2k_client.h"

static aria2::Session* g_session = nullptr;
static std::thread* g_runThread = nullptr;
static std::atomic<bool> g_running{false};

static void RunLoop() {
    int tick = 0;
    while (g_running) {
        int ret = aria2::run(g_session, aria2::RUN_ONCE);
        if (ret < 0) {
            OH_LOG_ERROR(LOG_APP, "[aria2_napi] run() error: %{public}d", ret);
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
        } else {
            if (tick < 5) {
                OH_LOG_INFO(LOG_APP, "[aria2_napi] run() tick=%{public}d ret=%{public}d", tick, ret);
                tick++;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

static napi_value Aria2NativeInit(napi_env env, napi_callback_info info) {
    size_t argc = 5;
    napi_value args[5];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    std::string saveDir, trackers, proxy;
    int maxPeers = 128, listenPort = 6881;

    if (argc > 0) {
        size_t len;
        napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
        std::vector<char> buf(len + 1);
        napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
        saveDir = buf.data();
    }
    if (argc > 1) {
        size_t len;
        napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
        std::vector<char> buf(len + 1);
        napi_get_value_string_utf8(env, args[1], buf.data(), len + 1, &len);
        trackers = buf.data();
    }
    if (argc > 2) {
        size_t len;
        napi_get_value_string_utf8(env, args[2], nullptr, 0, &len);
        std::vector<char> buf(len + 1);
        napi_get_value_string_utf8(env, args[2], buf.data(), len + 1, &len);
        proxy = buf.data();
    }
    if (argc > 3) napi_get_value_int32(env, args[3], &maxPeers);
    if (argc > 4) napi_get_value_int32(env, args[4], &listenPort);

    int initRet = aria2::libraryInit();
    if (initRet != 0) {
        char errMsg[128];
        snprintf(errMsg, sizeof(errMsg), "aria2 libraryInit failed, ret=%d", initRet);
        napi_throw_error(env, nullptr, errMsg);
        return nullptr;
    }

    aria2::KeyVals options;
    options.emplace_back("dir", saveDir);
    options.emplace_back("enable-dht", "true");
    // enable-dht6 disabled (may not be compiled in)
    options.emplace_back("dht-listen-port", "6881");
    options.emplace_back("listen-port", "6881");
    options.emplace_back("dht-message-timeout", "10");
    // dht6 disabled
    options.emplace_back("bt-max-peers", std::to_string(maxPeers));
    options.emplace_back("bt-max-open-files", "100");
    options.emplace_back("bt-save-metadata", "true");
    options.emplace_back("bt-enable-lpd", "true");
    options.emplace_back("bt-tracker-interval", "0");
    options.emplace_back("bt-require-crypto", "false");
    options.emplace_back("bt-min-crypto-level", "plain");
    options.emplace_back("bt-force-encryption", "false");
    options.emplace_back("piece-length", "1M");
    options.emplace_back("disk-cache", "64M");
    options.emplace_back("file-allocation", "none");
    options.emplace_back("enable-peer-exchange", "true");
    options.emplace_back("event-poll", "epoll");
    options.emplace_back("max-concurrent-downloads", "5");
    options.emplace_back("continue", "true");
    options.emplace_back("log-level", "debug");
    options.emplace_back("log", saveDir + "/aria2.log");
    options.emplace_back("check-certificate", "false");
    options.emplace_back("bt-request-peer-speed-limit", "10M");
    options.emplace_back("seed-ratio", "0.0");
    options.emplace_back("max-upload-limit", "0");
    options.emplace_back("min-split-size", "5M");
    options.emplace_back("split", "5");
    options.emplace_back("max-connection-per-server", "16");
    options.emplace_back("bt-tracker-connect-timeout", "10");
    options.emplace_back("bt-tracker-timeout", "10");
    options.emplace_back("dht-entry-point", "router.bittorrent.com:6881");
    // dht6 entry disabled
    options.emplace_back("bt-stop-timeout", "0");
    options.emplace_back("follow-torrent", "mem");
    options.emplace_back("bt-metadata-only", "false");
    options.emplace_back("peer-id-prefix", "A2-1-37-0-");
    options.emplace_back("peer-agent", "aria2/1.37.0");
    options.emplace_back("user-agent", "aria2/1.37.0");
    options.emplace_back("connect-timeout", "30");
    options.emplace_back("timeout", "60");
    options.emplace_back("retry-wait", "10");
    options.emplace_back("max-tries", "5");
    // Add hardcoded DHT/tracker nodes captured from working client
    std::string extraTrackers = trackers;
    extraTrackers += ",udp://34.66.57.33:6969/announce";
    extraTrackers += ",udp://135.125.198.235:6969/announce";
    extraTrackers += ",udp://37.60.249.217:6969/announce";
    extraTrackers += ",udp://207.211.184.229:6969/announce";
    extraTrackers += ",udp://95.216.3.28:6969/announce";
    extraTrackers += ",udp://34.66.57.33:2710/announce";
    extraTrackers += ",udp://135.125.198.235:2710/announce";
    options.emplace_back("bt-tracker", extraTrackers);
    options.emplace_back("enable-upnp", "true");
    options.emplace_back("natpmp-port", "0");
    // More aggressive DHT settings
    options.emplace_back("dht-file-path", saveDir + "/dht.dat");
    options.emplace_back("enable-peer-exchange", "true");
    options.emplace_back("bt-enable-lpd", "true");
    options.emplace_back("bt-request-peer-speed-limit", "0");
    options.emplace_back("bt-max-peers", "200");
    options.emplace_back("max-upload-limit", "0");
    options.emplace_back("seed-ratio", "0.0");
    if (!proxy.empty()) options.emplace_back("http-proxy", proxy);

    aria2::SessionConfig config;
    config.keepRunning = true;
    config.useSignalHandler = false;

    g_session = aria2::sessionNew(options, config);
    if (!g_session) {
        OH_LOG_ERROR(LOG_APP, "[aria2_napi] sessionNew NULL");
        aria2::libraryDeinit();
        napi_throw_error(env, nullptr, "aria2 sessionNew failed");
        return nullptr;
    }
    OH_LOG_INFO(LOG_APP, "[aria2_napi] sessionNew OK, session=%{public}p", (void*)g_session);

    g_running = true;
    g_runThread = new std::thread(RunLoop);
    OH_LOG_INFO(LOG_APP, "[aria2_napi] RunLoop thread started");

    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Aria2NativeAddMagnet(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    std::string magnet, saveDir;
    size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    magnet = buf.data();
    if (argc > 1) {
        size_t len2;
        napi_get_value_string_utf8(env, args[1], nullptr, 0, &len2);
        std::vector<char> buf2(len2 + 1);
        napi_get_value_string_utf8(env, args[1], buf2.data(), len2 + 1, &len2);
        saveDir = buf2.data();
    }

    if (!g_session) { napi_throw_error(env, nullptr, "not initialized"); return nullptr; }

    aria2::A2Gid gid = 0;
    aria2::KeyVals opts;
    if (!saveDir.empty()) opts.emplace_back("dir", saveDir);
    opts.emplace_back("bt-save-metadata", "true");
    opts.emplace_back("bt-metadata-only", "false");
    std::vector<std::string> uris = {magnet};
    int ret = aria2::addUri(g_session, &gid, uris, opts);
    if (ret != 0) { napi_throw_error(env, nullptr, "addUri failed"); return nullptr; }

    std::string gidHex = aria2::gidToHex(gid);
    napi_value result;
    napi_create_string_utf8(env, gidHex.c_str(), gidHex.size(), &result);
    return result;
}

static napi_value Aria2NativeGetStatus(napi_env env, napi_callback_info info) {
    if (!g_session) { napi_throw_error(env, nullptr, "not initialized"); return nullptr; }
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string gidHex;
    size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    gidHex = buf.data();

    aria2::DownloadHandle* dh = aria2::getDownloadHandle(g_session, aria2::hexToGid(gidHex));
    if (!dh) {
        napi_value result; napi_create_object(env, &result);
        napi_value f; napi_get_boolean(env, false, &f);
        napi_set_named_property(env, result, "found", f);
        return result;
    }

    auto st = dh->getStatus();
    OH_LOG_INFO(LOG_APP, "[aria2_napi] gid=%{public}s status=%{public}d totalLen=%{public}ld completed=%{public}ld speed=%{public}d conn=%{public}d err=%{public}d name=%{public}s",
        gidHex.c_str(), (int)st, (long)dh->getTotalLength(), (long)dh->getCompletedLength(),
        dh->getDownloadSpeed(), dh->getConnections(), dh->getErrorCode(),
        dh->getBtMetaInfo().name.c_str());
    napi_value result; napi_create_object(env, &result);
    napi_value fv; napi_get_boolean(env, true, &fv);
    napi_set_named_property(env, result, "found", fv);

    int si = 0;
    switch (st) {
        case aria2::DOWNLOAD_ACTIVE: si = 0; break;
        case aria2::DOWNLOAD_WAITING: si = 1; break;
        case aria2::DOWNLOAD_PAUSED: si = 2; break;
        case aria2::DOWNLOAD_COMPLETE: si = 3; break;
        case aria2::DOWNLOAD_ERROR: si = 4; break;
        case aria2::DOWNLOAD_REMOVED: si = 5; break;
    }
    napi_value sv; napi_create_int32(env, si, &sv);
    napi_set_named_property(env, result, "status", sv);
    napi_value tv; napi_create_int64(env, dh->getTotalLength(), &tv);
    napi_set_named_property(env, result, "totalLength", tv);
    napi_value cv; napi_create_int64(env, dh->getCompletedLength(), &cv);
    napi_set_named_property(env, result, "completedLength", cv);
    napi_value spv; napi_create_int32(env, dh->getDownloadSpeed(), &spv);
    napi_set_named_property(env, result, "downloadSpeed", spv);
    napi_value cnv; napi_create_int32(env, dh->getConnections(), &cnv);
    napi_set_named_property(env, result, "connections", cnv);
    napi_value ev; napi_create_int32(env, dh->getErrorCode(), &ev);
    napi_set_named_property(env, result, "errorCode", ev);

    auto btMeta = dh->getBtMetaInfo();
    napi_value nameVal; napi_create_string_utf8(env, btMeta.name.c_str(), btMeta.name.size(), &nameVal);
    napi_set_named_property(env, result, "name", nameVal);

    napi_value files; napi_create_array(env, &files);
    int numFiles = dh->getNumFiles();
    OH_LOG_INFO(LOG_APP, "[aria2_napi] numFiles=%{public}d btMeta.name=%{public}s",
        numFiles, btMeta.name.c_str());
    for (int i = 0; i < numFiles; i++) {
        auto f = dh->getFile(i + 1);
        OH_LOG_INFO(LOG_APP, "[aria2_napi] file[%{public}d] path=%{public}s length=%{public}ld",
            i, f.path.c_str(), (long)f.length);
        napi_value fo; napi_create_object(env, &fo);
        napi_value fp; napi_create_string_utf8(env, f.path.c_str(), f.path.size(), &fp);
        napi_set_named_property(env, fo, "path", fp);
        napi_value fl; napi_create_int64(env, f.length, &fl);
        napi_set_named_property(env, fo, "length", fl);
        napi_set_element(env, files, i, fo);
    }
    napi_set_named_property(env, result, "files", files);
    aria2::deleteDownloadHandle(dh);
    return result;
}

static napi_value Aria2NativePause(napi_env env, napi_callback_info info) {
    if (!g_session) return nullptr;
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string gidHex; size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    int ret = aria2::pauseDownload(g_session, aria2::hexToGid(buf.data()), false);
    napi_value r; napi_create_int32(env, ret, &r); return r;
}

static napi_value Aria2NativeResume(napi_env env, napi_callback_info info) {
    if (!g_session) return nullptr;
    size_t argc = 1; napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string gidHex; size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    int ret = aria2::unpauseDownload(g_session, aria2::hexToGid(buf.data()));
    napi_value r; napi_create_int32(env, ret, &r); return r;
}


static napi_value Aria2NativeSetSelectFiles(napi_env env, napi_callback_info info) {
    if (!g_session) { napi_throw_error(env, nullptr, "not initialized"); return nullptr; }
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string gidHex, indices;
    size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    gidHex = buf.data();
    napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
    std::vector<char> buf2(len + 1);
    napi_get_value_string_utf8(env, args[1], buf2.data(), len + 1, &len);
    indices = buf2.data();

    aria2::KeyVals opts;
    opts.emplace_back("select-file", indices);
    int ret = aria2::changeOption(g_session, aria2::hexToGid(gidHex), opts);
    if (ret != 0) { napi_throw_error(env, nullptr, "changeOption failed"); return nullptr; }
    napi_value result; napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Aria2NativeRemove(napi_env env, napi_callback_info info) {
    if (!g_session) return nullptr;
    size_t argc = 2; napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    std::string gidHex; bool force = false; size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    if (argc > 1) napi_get_value_bool(env, args[1], &force);
    int ret = aria2::removeDownload(g_session, aria2::hexToGid(buf.data()), force);
    napi_value r; napi_create_int32(env, ret, &r); return r;
}

static napi_value Aria2NativeGlobalStat(napi_env env, napi_callback_info info) {
    if (!g_session) return nullptr;
    auto gs = aria2::getGlobalStat(g_session);
    napi_value result; napi_create_object(env, &result);
    napi_value ds; napi_create_int32(env, gs.downloadSpeed, &ds);
    napi_set_named_property(env, result, "downloadSpeed", ds);
    napi_value na; napi_create_int32(env, gs.numActive, &na);
    napi_set_named_property(env, result, "numActive", na);
    return result;
}

static napi_value Aria2NativeStop(napi_env env, napi_callback_info info) {
    if (g_session) {
        aria2::shutdown(g_session, true);
        g_running = false;
        if (g_runThread && g_runThread->joinable()) g_runThread->join();
        delete g_runThread; g_runThread = nullptr;
        aria2::sessionFinal(g_session);
        g_session = nullptr;
        aria2::libraryDeinit();
    }
    napi_value result; napi_get_boolean(env, true, &result); return result;
}

// Load .torrent file and create download task with selected files
static napi_value Aria2NativeAddTorrent(napi_env env, napi_callback_info info) {
    if (!g_session) { napi_throw_error(env, nullptr, "not initialized"); return nullptr; }
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    std::string torrentPath, saveDir, selectFiles;
    size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);
    torrentPath = buf.data();
    if (argc > 1) {
        napi_get_value_string_utf8(env, args[1], nullptr, 0, &len);
        std::vector<char> buf2(len + 1);
        napi_get_value_string_utf8(env, args[1], buf2.data(), len + 1, &len);
        saveDir = buf2.data();
    }
    if (argc > 2) {
        napi_get_value_string_utf8(env, args[2], nullptr, 0, &len);
        std::vector<char> buf3(len + 1);
        napi_get_value_string_utf8(env, args[2], buf3.data(), len + 1, &len);
        selectFiles = buf3.data();
    }

    aria2::A2Gid gid = 0;
    aria2::KeyVals opts;
    if (!saveDir.empty()) opts.emplace_back("dir", saveDir);
    if (!selectFiles.empty()) opts.emplace_back("select-file", selectFiles);
    opts.emplace_back("bt-save-metadata", "true");
    opts.emplace_back("bt-metadata-only", "false");

    int ret = aria2::addTorrent(g_session, &gid, torrentPath, opts);
    if (ret != 0) { napi_throw_error(env, nullptr, "addTorrent failed"); return nullptr; }

    std::string gidHex = aria2::gidToHex(gid);
    napi_value result;
    napi_create_string_utf8(env, gidHex.c_str(), gidHex.size(), &result);
    return result;
}

static napi_value Aria2NativeIsRunning(napi_env env, napi_callback_info info) {
    napi_value result;
    napi_get_boolean(env, g_session != nullptr && g_running, &result); return result;
}

// ED2K: Parse link
static napi_value Ed2kParseLink(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> buf(len + 1);
    napi_get_value_string_utf8(env, args[0], buf.data(), len + 1, &len);

    ed2k::Ed2kFileInfo fileInfo;
    bool ok = ed2k::Ed2kClient::ParseLink(buf.data(), fileInfo);

    napi_value result; napi_create_object(env, &result);
    napi_value okVal; napi_get_boolean(env, ok, &okVal);
    napi_set_named_property(env, result, "ok", okVal);
    if (ok) {
        napi_value nameVal; napi_create_string_utf8(env, fileInfo.filename.c_str(), fileInfo.filename.size(), &nameVal);
        napi_set_named_property(env, result, "filename", nameVal);
        napi_value sizeVal; napi_create_int64(env, fileInfo.fileSize, &sizeVal);
        napi_set_named_property(env, result, "fileSize", sizeVal);
        char hexHash[33];
        for (int i = 0; i < 16; i++) snprintf(hexHash + i*2, 3, "%02x", fileInfo.hash[i]);
        hexHash[32] = 0;
        napi_value hashVal; napi_create_string_utf8(env, hexHash, 32, &hashVal);
        napi_set_named_property(env, result, "hash", hashVal);
    }
    return result;
}

// ED2K: Query sources from servers
static napi_value Ed2kQuerySources(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    size_t len;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &len);
    std::vector<char> hashBuf(len + 1);
    napi_get_value_string_utf8(env, args[0], hashBuf.data(), len + 1, &len);
    int64_t fileSize = 0;
    napi_get_value_int64(env, args[1], &fileSize);
    int timeoutMs = 15000;
    if (argc > 2) napi_get_value_int32(env, args[2], &timeoutMs);

    uint8_t fileHash[16] = {0};
    std::string hashStr = hashBuf.data();
    for (int i = 0; i < 16 && i*2+1 < (int)hashStr.size(); i++) {
        char hex[3] = { hashStr[i*2], hashStr[i*2+1], 0 };
        fileHash[i] = (uint8_t)strtoul(hex, nullptr, 16);
    }

    ed2k::Ed2kClient client;
    const char** servers = ed2k::Ed2kClient::GetDefaultServers();
    std::vector<ed2k::Ed2kSource> sources;

    for (int i = 0; servers[i] && sources.empty(); i++) {
        OH_LOG_INFO(LOG_APP, "[ed2k] trying server %{public}s", servers[i]);
        if (client.Connect(servers[i], 4661, 5000)) {
            if (client.Login()) {
                client.QueryFile(fileHash, (uint32_t)fileSize, sources, timeoutMs);
            }
            client.Disconnect();
        }
    }

    napi_value result; napi_create_object(env, &result);
    napi_value countVal; napi_create_int32(env, (int)sources.size(), &countVal);
    napi_set_named_property(env, result, "count", countVal);

    napi_value arr; napi_create_array(env, &arr);
    for (size_t i = 0; i < sources.size(); i++) {
        napi_value src; napi_create_object(env, &src);
        napi_value ipVal; napi_create_string_utf8(env, sources[i].ipStr.c_str(), sources[i].ipStr.size(), &ipVal);
        napi_set_named_property(env, src, "ip", ipVal);
        napi_value portVal; napi_create_int32(env, sources[i].port, &portVal);
        napi_set_named_property(env, src, "port", portVal);
        napi_set_element(env, arr, i, src);
    }
    napi_set_named_property(env, result, "sources", arr);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"nativeInit", nullptr, Aria2NativeInit, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeAddMagnet", nullptr, Aria2NativeAddMagnet, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeAddTorrent", nullptr, Aria2NativeAddTorrent, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeGetStatus", nullptr, Aria2NativeGetStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativePause", nullptr, Aria2NativePause, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeResume", nullptr, Aria2NativeResume, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeRemove", nullptr, Aria2NativeRemove, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeSetSelectFiles", nullptr, Aria2NativeSetSelectFiles, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeGlobalStat", nullptr, Aria2NativeGlobalStat, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeStop", nullptr, Aria2NativeStop, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"nativeIsRunning", nullptr, Aria2NativeIsRunning, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"ed2kParseLink", nullptr, Ed2kParseLink, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"ed2kQuerySources", nullptr, Ed2kQuerySources, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc)/sizeof(desc[0]), desc);
    return exports;
}

static napi_module aria2Module = {
    .nm_version = 1, .nm_flags = 0, .nm_filename = nullptr,
    .nm_register_func = Init, .nm_modname = "torrent_napi",
    .nm_priv = nullptr, .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterAria2Module() {
    napi_module_register(&aria2Module);
}
