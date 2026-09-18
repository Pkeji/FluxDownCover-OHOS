cmake_minimum_required(VERSION 3.16)
project(torrent_napi)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# aria2头文件
include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/aria2/include
)

# 我们自己编译的静态库
set(ARIA2_LIBS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/aria2/lib)

add_library(torrent_napi SHARED
    aria2_napi.cpp
    ed2k_client.cpp
)

# 静态链接我们自己编译的aria2 + OpenSSL
target_link_libraries(torrent_napi
    ${ARIA2_LIBS_DIR}/libaria2.a
    ${ARIA2_LIBS_DIR}/libssl.a
    ${ARIA2_LIBS_DIR}/libcrypto.a
)

# 链接NAPI和系统库
target_link_libraries(torrent_napi ace_napi.z ace_ndk.z hilog_ndk.z)
target_link_libraries(torrent_napi pthread)
target_link_libraries(torrent_napi z)
target_link_libraries(torrent_napi resolv)
