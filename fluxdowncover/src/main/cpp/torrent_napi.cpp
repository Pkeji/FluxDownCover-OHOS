#include <napi/native_api.h>
#include <libtorrent/session.hpp>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/torrent_info.hpp>
#include <string>
#include <map>
#include <memory>

static lt::session* g_session = nullptr;
static std::map<std::string, lt::torrent_handle> g_torrents;

static std::string toHex(const char* data, size_t len) {
    static const char hex[] = "0123456789abcdef";
    std::string result;
    result.reserve(len * 2);
    for (size_t i = 0; i < len; i++) {
        result += hex[(data[i] >> 4) & 0xF];
        result += hex[data[i] & 0xF];
    }
    return result;
}

static napi_value InitSession(napi_env env, napi_callback_info info) {
    if (!g_session) {
        lt::settings_pack pack;
        pack.set_int(lt::settings_pack::alert_mask,
            lt::alert::error_notification | lt::alert::status_notification |
            lt::alert::tracker_notification | lt::alert::dht_notification);
        // 启用DHT
        pack.set_bool(lt::settings_pack::enable_dht, true);
        pack.set_bool(lt::settings_pack::enable_upnp, true);
        pack.set_bool(lt::settings_pack::enable_natpmp, true);
        pack.set_bool(lt::settings_pack::enable_lsd, true);
        // 监听端口
        pack.set_str(lt::settings_pack::listen_interfaces, "0.0.0.0:6881");
        // 连接数
        pack.set_int(lt::settings_pack::connections_limit, 200);
        pack.set_int(lt::settings_pack::request_queue_time, 3);
        g_session = new lt::session(pack);

        // 添加公共DHT节点
        g_session->add_dht_router(std::make_pair(std::string("router.bittorrent.com"), 6881));
        g_session->add_dht_router(std::make_pair(std::string("router.utorrent.com"), 6881));
        g_session->add_dht_router(std::make_pair(std::string("dht.transmissionbt.com"), 6881));
        g_session->add_dht_router(std::make_pair(std::string("dht.libtorrent.org"), 25401));
        g_session->add_dht_router(std::make_pair(std::string("router.bitcomet.com"), 6881));
    }
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value AddMagnet(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    size_t magnet_len = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &magnet_len);
    std::string magnet(magnet_len, '\0');
    napi_get_value_string_utf8(env, args[0], &magnet[0], magnet_len + 1, &magnet_len);

    size_t save_path_len = 0;
    napi_get_value_string_utf8(env, args[1], nullptr, 0, &save_path_len);
    std::string save_path(save_path_len, '\0');
    napi_get_value_string_utf8(env, args[1], &save_path[0], save_path_len + 1, &save_path_len);

    try {
        lt::add_torrent_params params = lt::parse_magnet_uri(magnet);
        params.save_path = save_path;
        // 添加HTTP/HTTPS tracker（走代理）
        const char* trackers[] = {
            "https://tracker.bt-hash.com:443/announce",
            "https://tracker.tamersunion.org:443/announce",
            "https://tracker.lilithraws.cf:443/announce",
            "https://tracker.birkenwald.de:443/announce",
            "https://tracker.moeking.me:443/announce",
            "https://tracker.nanoha.org:443/announce",
            "http://tracker.opentrackr.org:1337/announce",
            "http://tracker.openbittorrent.com:80/announce",
            nullptr
        };
        for (int i = 0; trackers[i]; i++) {
            params.trackers.push_back(trackers[i]);
        }
        lt::torrent_handle h = g_session->add_torrent(params);
        lt::sha1_hash ih = h.info_hash();
        std::string id = toHex(ih.data(), 20);
        g_torrents[id] = h;

        napi_value result;
        napi_create_string_utf8(env, id.c_str(), id.size(), &result);
        return result;
    } catch (const std::exception& e) {
        napi_throw_error(env, nullptr, e.what());
        return nullptr;
    }
}

static napi_value GetStatus(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    size_t id_len = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &id_len);
    std::string id(id_len, '\0');
    napi_get_value_string_utf8(env, args[0], &id[0], id_len + 1, &id_len);

    napi_value result;
    napi_create_object(env, &result);

    auto it = g_torrents.find(id);
    if (it == g_torrents.end()) {
        napi_value found;
        napi_get_boolean(env, false, &found);
        napi_set_named_property(env, result, "found", found);
        return result;
    }

    lt::torrent_status st = it->second.status();

    napi_value found, name, progress, download_rate, state, total, done;
    napi_get_boolean(env, true, &found);
    napi_create_string_utf8(env, st.name.c_str(), st.name.size(), &name);
    napi_create_double(env, st.progress, &progress);
    napi_create_int64(env, st.download_rate, &download_rate);
    napi_create_int32(env, static_cast<int>(st.state), &state);
    napi_create_int64(env, st.total_done, &done);
    napi_create_int64(env, st.total, &total);

    napi_set_named_property(env, result, "found", found);
    napi_set_named_property(env, result, "name", name);
    napi_set_named_property(env, result, "progress", progress);
    napi_set_named_property(env, result, "downloadRate", download_rate);
    napi_set_named_property(env, result, "state", state);
    napi_set_named_property(env, result, "total", total);
    napi_set_named_property(env, result, "done", done);

    return result;
}

static napi_value Pause(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    size_t id_len = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &id_len);
    std::string id(id_len, '\0');
    napi_get_value_string_utf8(env, args[0], &id[0], id_len + 1, &id_len);
    auto it = g_torrents.find(id);
    if (it != g_torrents.end()) it->second.pause();
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Resume(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    size_t id_len = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &id_len);
    std::string id(id_len, '\0');
    napi_get_value_string_utf8(env, args[0], &id[0], id_len + 1, &id_len);
    auto it = g_torrents.find(id);
    if (it != g_torrents.end()) it->second.resume();
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Remove(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
    size_t id_len = 0;
    napi_get_value_string_utf8(env, args[0], nullptr, 0, &id_len);
    std::string id(id_len, '\0');
    napi_get_value_string_utf8(env, args[0], &id[0], id_len + 1, &id_len);
    auto it = g_torrents.find(id);
    if (it != g_torrents.end()) {
        g_session->remove_torrent(it->second);
        g_torrents.erase(it);
    }
    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor desc[] = {
        {"initSession", nullptr, InitSession, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"addMagnet", nullptr, AddMagnet, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getStatus", nullptr, GetStatus, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"pause", nullptr, Pause, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resume", nullptr, Resume, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
    };
    napi_define_properties(env, exports, sizeof(desc)/sizeof(desc[0]), desc);
    return exports;
}

static napi_module torrentModule = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "libtorrent_napi",
    .nm_priv = nullptr,
    .reserved = {nullptr, nullptr, nullptr, nullptr},
};

extern "C" __attribute__((constructor)) void RegisterTorrentModule(void) {
    napi_module_register(&torrentModule);
}
