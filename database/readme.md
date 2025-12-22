Install command line tool
```
brew install libpq
```

Create db and role

```
psql --host localhost --username postgres -W -f create-db.sql
```

Create the tables
```
psql --host localhost --username python_pvp_admin -W -f init-db.sql
```