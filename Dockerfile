FROM node:22.16-alpine

RUN apk update
RUN apk add bash

RUN mkdir /code
WORKDIR /code
