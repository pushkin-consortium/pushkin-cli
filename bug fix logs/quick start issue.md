# pushkin init site issue:

## problem:
`
No container found for test_db_1
Failed to run create database command in test_db container: 1
`

## potential solution:
update `services: test_db` in `pushkin/docker-compose.dev.yml` to look like this:
`
test_db:
    image: 'postgres:11'
    environment:
        POSTGRES_PASSWORD: testpassword
    ports:
      - '5432:5432'
    volumes:
      - 'test_db_volume:/var/lib/postgresql/data'
`


# pushkin setupdb issue:

## problems:
`Error: connect ECONNREFUSED 127.0.01:5432`

## potential solution:
the connect error is probably because of the port conflicts, make sure the port 5432 is empty when start the quick start

If not, maybe the PostgreSQL is not started or login/password for pg is not good, maybe because of the configuration errors in docker. The probelm in docker config file is still waited to be found.
