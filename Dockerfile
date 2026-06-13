# Immunity template agent — one image, role-selected by AGENT_ROLE.
#
# The agent depends on the Immunity SDK via a `file:../immunity-sdk` path while
# the SDK is unpublished, so the build context must be the PARENT directory that
# holds BOTH `immunity-agent` and `immunity-sdk` as siblings:
#
#   docker build -f immunity-agent/Dockerfile -t ghcr.io/immunity-protocol/agent ..
#
# (Once the SDK is published to npm this collapses to a normal single-context
# build — swap the file: dependency for the npm version and drop the SDK COPY.)

# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /build

# Bring in the sibling SDK (published files: it ships its own prebuilt dist).
COPY immunity-sdk/ ./immunity-sdk/

# Install + build the agent against the local SDK.
COPY immunity-agent/package.json immunity-agent/package-lock.json* ./immunity-agent/
WORKDIR /build/immunity-agent
RUN npm install --no-audit --no-fund
COPY immunity-agent/tsconfig.json ./
COPY immunity-agent/src/ ./src/
RUN npm run build

# Prune to production deps for the runtime image.
RUN npm prune --omit=dev

# --- runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The SDK must travel with the agent because node_modules links to it by path.
COPY --from=build /build/immunity-sdk /immunity-sdk
COPY --from=build /build/immunity-agent/node_modules ./node_modules
COPY --from=build /build/immunity-agent/dist ./dist
COPY --from=build /build/immunity-agent/package.json ./package.json

# Run as the unprivileged node user.
USER node

ENTRYPOINT ["node", "dist/index.js"]
