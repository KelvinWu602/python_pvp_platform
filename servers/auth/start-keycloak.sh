docker run --name keycloak -p 127.0.0.1:8080:8080 \
    -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
    -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
    -e KC_DB=postgres \
    -e "KC_DB_URL=jdbc:postgresql://python_pvp_test_db:5432/keycloak" \
    -e KC_DB_USERNAME=kc_admin \
    -e KC_DB_PASSWORD=abcd1234 \
    -e KC_HOSTNAME=localhost \
    -e KC_HOSTNAME_PORT=8080 \
    -e "KC_HOSTNAME_STRICT=false" \
    -e "KC_HOSTNAME_STRICT_HTTPS=false" \
    --network python_pvp_network \
    quay.io/keycloak/keycloak:26.4.7 \
    start-dev


# docker run -p 127.0.0.1:8080:8080 \
#     -e KC_BOOTSTRAP_ADMIN_USERNAME=admin \
#     -e KC_BOOTSTRAP_ADMIN_PASSWORD=admin \
#     quay.io/keycloak/keycloak:26.4.7 \
#     start-dev
