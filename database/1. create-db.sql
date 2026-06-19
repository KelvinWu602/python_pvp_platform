-- to be executed in any database
CREATE ROLE python_pvp_admin LOGIN PASSWORD 'temp';
GRANT python_pvp_admin TO postgres;
CREATE DATABASE python_pvp WITH OWNER python_pvp_admin;