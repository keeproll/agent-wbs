# Agent WBS 운영 이미지(M8-06). 빌드 맥락(context)은 agent-wbs 폴더다.
#   docker compose -p awbs-prod -f agent-wbs/deploy/compose.prod.yaml build
#
# 대상(target) 두 개를 만든다.
# - app: API와 worker가 함께 쓰는 이미지. PDF용 Chromium이 들어 있다(API의 PDF 내려받기와 worker의 메일 첨부가 둘 다 PDF를 만든다).
# - web: 빌드한 화면 파일을 내보내고 /api·/health를 API로 넘기는 nginx 이미지.
# 기반 이미지는 digest(내용 지문)로 고정한다. 왜: 같은 커밋을 다시 빌드하면 같은 기반 위에서 만들어져야 되돌리기가 믿을 만하다.
# 비밀값은 이미지에 넣지 않는다. 실행할 때 /run/secrets 파일로만 받는다(app-entrypoint.sh).

ARG NODE_IMAGE=node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-bookworm@sha256:593a17dc61d117d1bfb208246903265abe0047c5bd4508b6e790895924b24c31

# ---- 1. 빌드: 의존성 설치 → 전체 빌드 → 운영 의존성만 남기기 ----
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=1
ENV PATH=/pnpm:$PATH
RUN npm install --global --no-fund --no-audit pnpm@12.16.1
WORKDIR /src
# lockfile과 package.json만 먼저 복사한다. 왜: 소스만 바뀌었을 때 의존성 설치 단계를 캐시에서 다시 쓴다.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r run build
# 개발용 의존성을 지운다. 왜: 운영 이미지에는 실행에 필요한 것만 둔다.
RUN pnpm install --frozen-lockfile --prod --offline

# ---- 2. app: API · worker ----
FROM ${NODE_IMAGE} AS app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=UTC
# PDF용 Chromium(headless shell)과 실행에 필요한 시스템 라이브러리. playwright-core 버전은 apps/api/package.json과 같다.
RUN npx --yes playwright-core@1.65.1 install --with-deps --only-shell chromium \
    && rm -rf /var/lib/apt/lists/* /root/.npm
WORKDIR /app
COPY --from=build --chown=root:root /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/packages/shared/package.json packages/shared/
COPY --from=build --chown=root:root /src/packages/shared/dist packages/shared/dist
COPY --from=build --chown=root:root /src/packages/shared/node_modules packages/shared/node_modules
COPY --from=build --chown=root:root /src/packages/db/package.json packages/db/
COPY --from=build --chown=root:root /src/packages/db/dist packages/db/dist
COPY --from=build --chown=root:root /src/packages/db/migrations packages/db/migrations
COPY --from=build --chown=root:root /src/packages/db/seed packages/db/seed
COPY --from=build --chown=root:root /src/packages/db/node_modules packages/db/node_modules
COPY --from=build --chown=root:root /src/apps/api/package.json apps/api/
COPY --from=build --chown=root:root /src/apps/api/dist apps/api/dist
COPY --from=build --chown=root:root /src/apps/api/node_modules apps/api/node_modules
COPY --chown=root:root --chmod=0755 deploy/app-entrypoint.sh /usr/local/bin/awbs-entrypoint
# 데이터 파일(evidence·PDF) 폴더. 앱은 「홈/.agentwbs/wbs」를 쓴다(apps/api/src/reset/files.ts DATA_ROOT).
# 이름 있는 볼륨을 처음 붙이면 이 폴더의 소유자·권한(node, 0700)을 그대로 이어받는다.
RUN install -d -o node -g node -m 0700 /home/node/.agentwbs /home/node/.agentwbs/wbs
# 프로그램 파일은 root 소유·읽기 전용이고, 실행은 일반 계정(node)으로 한다. 왜: 앱이 뚫려도 자기 코드를 바꾸지 못하게 한다.
USER node
ENTRYPOINT ["/usr/local/bin/awbs-entrypoint"]
CMD ["api"]

# ---- 3. web: 화면 파일 + API로 넘기기 ----
FROM ${NGINX_IMAGE} AS web
COPY --chown=root:root deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=root:root /src/apps/web/dist /usr/share/nginx/html
