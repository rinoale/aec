ARG TARGETARCH

FROM public.ecr.aws/amazonlinux/amazonlinux:2023-minimal AS base

FROM base AS rpm-amd64
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-x86_64.rpm /tmp/aws-emulator.rpm

FROM base AS rpm-arm64
ADD https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator-aarch64.rpm /tmp/aws-emulator.rpm

FROM rpm-${TARGETARCH}
RUN rpm -i /tmp/aws-emulator.rpm && rm /tmp/aws-emulator.rpm \
    && mkdir -p /home/emulator && chown 1000 /home/emulator
USER 1000
ENV HOME=/home/emulator EMULATOR_BIND_ADDRESS=0.0.0.0 EMULATOR_TELEMETRY=off
ENTRYPOINT ["aws-emulator"]
