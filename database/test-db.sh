#! /bin/bash

docker pull arm64v8/postgres:18.1
docker volume create python_pvp_test_db
docker run --name python_pvp_test_db \
    -p 5432:5432 \
    --mount type=volume,src=python_pvp_test_db,dst=/var/lib/postgresql \
    -e POSTGRES_PASSWORD=abcd1234 \
    -d \
    arm64v8/postgres:18.1



