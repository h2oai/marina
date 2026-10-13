# Integrations

`langchain-resident.py` connects a LangChain agent to Marina over MCP and keeps one persistent
resident session; `--inspect-only` checks login, discovery and a world read without model calls.

Run (with Marina started and the Python dependencies installed as in the guide):
`.venv/bin/python examples/integrations/langchain-resident.py --inspect-only --token-file "$HOME/.config/marina/langchain.json"`

Guide: [LangChain and LangGraph](../../docs/guides/langchain.md).
