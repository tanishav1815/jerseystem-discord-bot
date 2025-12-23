# Discord Form Bot

A generic Discord chatbot that runs a Google-Form-style questionnaire inside a Discord channel.

## Features
- **Dynamic Questions**: Loads questions from a SQLite database.
- **Multiple Types**: Supports Text, Single Choice (Buttons/Select), Multiple Choice, Yes/No.
- **Persistence**: Remembers user progress even if the bot restarts.
- **Data Storage**: Saves all answers to `form_bot.sqlite`.

## Setup

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Configure Environment**:
    - Open `.env` and paste your `DISCORD_TOKEN` and `CLIENT_ID`.

3.  **Run the Bot**:
    ```bash
    node src/index.js
    ```
    - On first run, it will create `form_bot.sqlite` and seed it with sample questions.

4.  **Usage**:
    - Type `/start` in your Discord server to begin the form.

## Project Structure
- `src/db.js`: Database initialization and schema.
- `src/formEngine.js`: Core logic for managing form state and rendering questions.
- `src/index.js`: Main bot entry point and event listeners.
