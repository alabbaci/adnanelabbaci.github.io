# PanelUI (vendored)

Vendored copy of the Claude Code plugin and skills from
[panel-ui/PanelUI](https://github.com/panel-ui/PanelUI) at commit
`c4c955328c9a166843e6154f8fda2eb7ba58dc7e` (MIT, see [LICENSE](LICENSE)).

Contents:

- `.claude-plugin/plugin.json` — plugin manifest, including the `panelui` MCP server
  (`npx -y panelui-cli@latest mcp`).
- `skills/panelui/` — the PanelUI component skill (props for every component, setup,
  theming, recipes, CLI and MCP docs).
- `skills/logo-maker/` — the logo-maker skill.

How it is wired up in this repo:

- `.claude-plugin/marketplace.json` (repo root) lists this plugin in the
  `adnanelabbaci-plugins` marketplace.
- `.claude/settings.json` registers that marketplace and enables
  `panelui@adnanelabbaci-plugins`, so Claude Code offers to install it when the repo is trusted.
- `.claude/skills/panelui` and `.claude/skills/logo-maker` are symlinks to the skills here, so
  they are also available as plain project skills without installing the plugin.

To install manually:

```
/plugin marketplace add ./
/plugin install panelui@adnanelabbaci-plugins
```

To update, re-copy `skills/` and `.claude-plugin/plugin.json` from upstream.
