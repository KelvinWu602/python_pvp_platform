#! /bin/bash

docker pull arm64v8/postgres:18.1

# 創建docker volume
docker volume create python_pvp_test_db

# 創建docker network
docker network create python_pvp_network

# 創建docker 容器
docker run --name python_pvp_test_db \
    -p 5432:5432 \
    --mount type=volume,src=python_pvp_test_db,dst=/var/lib/postgresql \
    -e POSTGRES_PASSWORD=abcd1234 \
    --network python_pvp_network \
    -d \
    arm64v8/postgres:18.1


