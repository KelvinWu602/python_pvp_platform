Install command line tool
```
brew install libpq
```

Create db and role

```
psql --host localhost --username postgres -W -f 1.\ create-db.sql
```

Create the tables
```
psql --host localhost --dbname python_pvp --username python_pvp_admin -W -f 2.\ init-db.sql
```

Create the extensions
```
psql --host localhost --dbname python_pvp --username python_pvp_admin -W -f 3.\ extension.sql
```

Create SSH Tunnel to the RDS
```
ssh -i sensitive/python-pvp-ec2.pem -N -L 5433:python-pvp-db.cpwowc44igh2.ap-southeast-1.rds.amazonaws.com:5432 ubuntu@13.212.111.107
```
