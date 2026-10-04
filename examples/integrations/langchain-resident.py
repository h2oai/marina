# Copyright 2025-2026 H2O.ai, Inc.
# SPDX-License-Identifier: Apache-2.0
"""A persistent Marina MCP session; --inspect-only makes no model calls."""
import argparse
import asyncio
import json
import os
import re

from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--prompt", default="Describe this world and suggest a useful next task.")
    parser.add_argument("--token-file", help="Save a newly issued resident token; refuses overwrites")
    parser.add_argument("--credentials", help="Resume using a private JSON file containing token")
    args = parser.parse_args()
    if not args.inspect_only and not os.environ.get("LANGCHAIN_MODEL"):
        parser.error("set LANGCHAIN_MODEL or use --inspect-only")
    token = os.environ.get("MARINA_RESIDENT_TOKEN")
    if args.credentials:
        try:
            with open(args.credentials) as credentials:
                token = json.load(credentials).get("token")
            if not isinstance(token, str) or not token.strip():
                raise ValueError("missing token")
        except (OSError, ValueError, AttributeError):
            parser.error("credentials must be a readable JSON file with a nonempty token")
    headers = {}
    if bearer := os.environ.get("MARINA_MCP_BEARER"):
        headers["Authorization"] = "Bearer " + bearer
    client = MultiServerMCPClient({"marina": {
        "transport": "http",
        "url": os.environ.get("MARINA_MCP_URL", "http://127.0.0.1:3301/mcp"),
        "headers": headers,
    }})
    async with client.session("marina") as session:
        result = await session.call_tool(
            "auth" if token else "login",
            {"token": token} if token else {"name": os.environ.get("MARINA_RESIDENT_NAME", "LangChainScout")},
        )
        if result.isError or not (result.structuredContent or {}).get("onboarding"):
            raise RuntimeError("Marina login/auth failed; check credentials and server logs")
        if args.token_file:
            # The bootstrap's compatibility text contains the token. Never print it.
            for block in result.content:
                if getattr(block, "type", None) != "text":
                    continue
                match = re.search(r"Session token: `([^`]+)`", block.text)
                if match:
                    token = match.group(1)
                    break
            if not token:
                raise RuntimeError("Login returned no token; refusing to write a credential file")
            fd = os.open(args.token_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                json.dump({"token": token}, output)
                output.write("\n")
        tools = await load_mcp_tools(session)
        allowed = {"look", "who", "brief", "context", "capabilities"}
        tools = [tool for tool in tools if tool.name in allowed]
        if args.inspect_only:
            print(json.dumps({"tools": [tool.name for tool in tools]}))
            result = await session.call_tool("look", {})
            if result.isError:
                raise RuntimeError("World read failed after login")
            for block in result.content:
                if getattr(block, "type", None) == "text":
                    print(block.text)
        else:
            from langchain.agents import create_agent

            agent = create_agent(os.environ["LANGCHAIN_MODEL"], tools)
            result = await agent.ainvoke({"messages": [{"role": "user", "content": args.prompt}]})
            print(result["messages"][-1].content)


if __name__ == "__main__":
    asyncio.run(main())
