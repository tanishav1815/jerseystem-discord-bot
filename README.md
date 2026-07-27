# JerseySTEM Discord Bot

A Python-based Discord bot that manages onboarding questionnaires, audits user information against live database records, syncs data with Google Sheets, and acts as a Q&A chatbot using Gemini AI.

## Features
- **Dynamic Onboarding**: Collects member profiles via a structured Discord Q&A flow.
- **AI-Powered Knowledge Base**: Answers community questions by referencing Google Docs, Sheets, and MySQL databases via Gemini 2.5.
- **Two-Way Sync**: Dynamically updates the contact database and sends webhook payloads when user profiles change.
- **Background Auditing**: Automatically scans members periodically for missing profile fields and prompts them to fill them in.
- **Docker Support**: Containerized structure with multi-platform extra-host support.

---

## Setup & Running (Local)

### 1. Configure Environment
1. Copy the template:
   ```bash
   cp .env.example .env
   ```
2. Open `.env` and fill in your Discord token, database credentials, Gemini API key, and Google Doc/Sheet IDs.

### 2. Set Up Virtual Environment
Initialize your Python environment and install dependencies:
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Run the Bot
To run the bot locally:
```bash
.venv/bin/python -m src.main
```

---

## Run with Docker & Docker Compose

For ease of deployment and isolation, you can run the bot in a Docker container.

### 1. Build and Start Container
Ensure you have created your `.env` file first, then run:
```bash
docker-compose up --build -d
```
This runs the bot container in the background (`-d`) and auto-restarts it if it crashes.

### 2. Local Database Connections in Docker
If you are running MySQL locally on your host machine (outside Docker) and the bot container needs to connect to it:
1. Open your `.env` file and set:
   ```env
   DB_HOST=host.docker.internal
   ```
2. Open `docker-compose.yml` and uncomment the `extra_hosts` section:
   ```yaml
   extra_hosts:
     - "host.docker.internal:host-gateway"
   ```
3. Restart the container:
   ```bash
   docker-compose up -d
   ```

---

## Project Structure
- `src/main.py`: Bot entry point, event listeners, and slash commands.
- `src/form_engine.py`: Questionnaire flow, onboarding form engine, and Q&A chatbot logic.
- `src/db.py`: Database pool manager and schema initialization.
- `src/permissions.py`: Role-based access control (RBAC) checks.
- `scripts/reset_test_data.py`: Helper script to clear a user's test records.
- `Dockerfile` & `docker-compose.yml`: Containerization and environment orchestration.
