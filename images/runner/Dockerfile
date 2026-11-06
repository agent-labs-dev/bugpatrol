# The determinism contract lives here.
#
# Baselines are captured in EXACTLY this image and compared in EXACTLY this
# image. That single decision removes the whole class of cross-machine
# rendering drift, which the research identifies as the number-one reason teams
# abandon visual testing. Where competing tools tell users to "generate
# baselines on a machine that matches CI", this makes the question structurally
# impossible to get wrong.
#
# Consequence: changing this file changes the image digest, and a digest change
# INVALIDATES every baseline and forces a re-capture. That is correct behaviour,
# not a bug -- silently diffing across image versions is what produces a diff
# storm nobody can explain.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy

# Fonts are bundled and host fonts are absent, so a glyph can never fall back to
# whatever happened to be installed on the runner. `failOnFontFallback` turns a
# substitution into a loud error rather than a mysterious text-shaped diff.
RUN apt-get update && apt-get install -y --no-install-recommends \
      fontconfig \
      fonts-dejavu-core \
      fonts-liberation2 \
      fonts-noto-core \
      fonts-noto-color-emoji \
      ffmpeg \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

# Pin the timezone and locale. Number, date and currency formatting all depend
# on these, and all three render as pixels.
ENV TZ=UTC \
    LANG=en_US.UTF-8 \
    LC_ALL=en_US.UTF-8 \
    NODE_ENV=test

WORKDIR /work

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY examples ./examples

# pnpm from npm rather than corepack: the corepack bundled with this image's
# Node predates npm's registry signing-key rotation and refuses every download
# with "Cannot find matching keyid". The version matches packageManager.
RUN npm install -g pnpm@9.12.0 \
 && pnpm install --frozen-lockfile \
 && pnpm build

ENTRYPOINT ["node", "/work/packages/cli/dist/bin.js"]
