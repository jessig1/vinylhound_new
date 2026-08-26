# VinylHound

VinylHound is a mobile-first application for identifying vinyl albums from cover photos and organizing the results into a collection or wishlist. It supports camera capture, single-photo upload, and batch ingestion.

This repository contains the completed project foundation and a working first
vertical slice: the mobile web flow captures or selects a cover, uploads it with
progress, survives analysis through a refresh-safe status page, presents ranked
candidates for correction, and atomically adds the reviewed release to collection
or wishlist. PostgreSQL persistence, signed S3-compatible uploads, server-side
validation, transactional queue delivery, OpenAI analysis, and the complete audit
trail sit behind the web and worker boundaries.

## Product shape

1. A user captures or uploads one or more photos for an album.
2. The app stores the originals and creates an asynchronous scan.
3. A worker asks the OpenAI Responses API for structured album candidates.
4. Domain policy marks the result identified, review-required, or unresolved.
5. The user confirms/corrects the result and adds it to their collection or wishlist.

Album-cover recognition and pressing identification are deliberately separate. A front cover can often identify an artist and title; a particular edition may require the back cover, spine, label, barcode, catalog number, runout data, or a catalog lookup.

## Repository map

```text
apps/
  web/          Mobile-first Next.js app and future HTTP API
  worker/       Retryable image-analysis and batch processing
packages/
  ai/           AI provider port and OpenAI adapter
  config/       Server environment validation
  contracts/    Runtime-validated API, job, and AI schemas
  database/     Persistence boundary and future migrations
  domain/       Business rules with no infrastructure dependencies
  queue/        Background-job contracts
  storage/      Object-storage port
docs/
  decisions/    Architecture decision records
```

## Quick start

Requirements: Node.js 22 or newer, npm 10 or newer, Docker, and Docker Compose.

```bash
npm install
copy .env.example .env
docker compose up -d
npm run db:migrate
npm run dev
```

On macOS or Linux, use `cp .env.example .env`. Open `http://localhost:3000`.

The web shell does not require an OpenAI key. Before wiring or running image analysis, create an OpenAI API project/key and set `OPENAI_API_KEY` only in the server/worker environment. The consumer ChatGPT product is not called directly; VinylHound uses the OpenAI API.

Run `npm run dev:worker` in a second terminal to publish committed outbox rows to
Redis. When `OPENAI_API_KEY` is non-empty, the same process starts the BullMQ
analysis consumer. Without a key, publication still runs and analysis jobs remain
waiting without making billable API calls.

Run the repository checks with:

```bash
npm run check
npm run build
```

## Documentation

- [Product definition](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Domain model](docs/DOMAIN.md)
- [API and job contracts](docs/API.md)
- [OpenAI integration](docs/OPENAI_INTEGRATION.md)
- [Security and privacy](docs/SECURITY.md)
- [Testing and AI evaluations](docs/TESTING.md)
- [Delivery roadmap](docs/ROADMAP.md)
- [Architecture decisions](docs/decisions/README.md)

## Current boundaries

The repository is a modular monolith, not a collection of deployed microservices. The web app and worker are separate processes, while shared packages enforce boundaries. That is enough separation for independent scaling later without forcing distributed-system overhead into the personal-project phase.
