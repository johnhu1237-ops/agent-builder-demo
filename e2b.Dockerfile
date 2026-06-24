FROM node:22-bookworm

RUN corepack enable
RUN npm install -g @openai/codex@0.50.0

WORKDIR /home/user/workspace
RUN chown -R node:node /home/user
USER node

RUN mkdir -p /home/user/workspace
