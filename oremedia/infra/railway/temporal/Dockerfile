# Self-hosted Temporal server for Railway (used only if Temporal Cloud is not chosen; spec 3.1).
# Persistence is a SEPARATE Railway MySQL 8 instance, never the application database.
FROM temporalio/auto-setup:1.26.2
ENV DB=mysql8 \
    DBNAME=temporal \
    VISIBILITY_DBNAME=temporal_visibility \
    SKIP_DB_CREATE=false \
    NUM_HISTORY_SHARDS=512 \
    TEMPORAL_ADDRESS=0.0.0.0:7233 \
    BIND_ON_IP=0.0.0.0
# Set on the Railway service from the Temporal MySQL plugin: MYSQL_SEEDS, DB_PORT, MYSQL_USER, MYSQL_PWD.
EXPOSE 7233
