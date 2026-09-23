"""Allow `python -m agent_memory` as an alternative to the `memory` console script.

The OMP runner prefers the installed `memory` entry point and uses this module
when only the Python interpreter is available.
"""

from agent_memory.cli import cli

if __name__ == "__main__":
    cli(prog_name="memory")
