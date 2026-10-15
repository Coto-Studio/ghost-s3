FROM ghost

LABEL org.opencontainers.image.source="https://github.com/Coto-Studio/ghost-s3"

# Ghost searches `paths.installedAdaptersPath` for adapters. It exists as an
# escape hatch for exactly this case — a custom Docker build that ships an
# adapter — and keeps it out of the bind-mounted/volumed content directory.
# The older `content/adapters` location still works but Ghost has it marked for
# possible removal in 7.0.
ENV paths__installedAdaptersPath=/var/lib/ghost/adapters

# The adapter is vendored in ./adapter rather than installed from npm — see
# README.md. Its dependencies are installed alongside it so the directory is
# self-contained.
COPY adapter/ /var/lib/ghost/adapters/storage/s3/

RUN npm install --omit=dev --no-audit --no-fund \
      --prefix /var/lib/ghost/adapters/storage/s3 \
  && npm cache clean --force
