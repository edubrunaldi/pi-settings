# pi-settings

Minhas customizações do [Pi](https://pi.dev) / Pi-Bolt versionadas num só lugar:
extensões, skills, prompt templates e temas. O repo é um **Pi package** válido
(`package.json` com o manifesto `pi`), então serve tanto para instalar via git
quanto para copiar para `~/.pi/agent`.

```text
pi-settings/
├── package.json        # manifesto do Pi package (pi.extensions / skills / prompts)
├── extensions/         # extensões TypeScript (carregadas por arquivo, ou pasta com index.ts)
├── skills/             # uma pasta por skill, cada uma com SKILL.md
├── prompts/            # prompt templates: o nome do arquivo vira o comando /nome
├── plan-flow/          # overrides das instruções de fase da extensão plan (copiados no install)
├── themes/             # temas JSON (criado quando houver o primeiro)
├── docs/               # documentação longa de cada recurso
├── tests/              # testes offline + stubs dos pacotes do host
└── scripts/            # install.ps1 / install.sh
```

## Extensões

| Extensão | Arquivo | Comando | Ferramentas | Para que serve | Doc |
|---|---|---|---|---|---|
| **plan** | `extensions/plan.ts` | `/plan` | `plan_advance`, `plan_title` | Fluxo de planejamento em fases (`investigate → summary → plan → ready`) com aprovação humana, plano escrito direto num arquivo `.md` e sessão nova para implementar | [docs/plan.md](docs/plan.md) |

### `/plan` em uma tabela

| Comando | O que faz |
|---|---|
| `/plan start <problema>` | começa na fase de investigação (manda o prompt de kickoff) |
| `/plan summary` | pede o resumo (atalho; o modelo também pode pedir via `plan_advance`) |
| `/plan approve` | aprova o resumo (→ planejamento, cria o arquivo) / aprova o plano (→ pronto, oferece sessão nova) |
| `/plan title <2-4 palavras>` | renomeia o plano (título e nome do arquivo) |
| `/plan back <fase>` | volta para `investigate` \| `summary` \| `plan` |
| `/plan guard on\|off` | liga/desliga o bloqueio de `edit`/`write` em investigate/summary |
| `/plan status` | estado atual |
| `/plan stop` | desliga o fluxo |

O que a extensão protege e o que não protege: `edit`/`write` são bloqueados em
`investigate`/`summary`, mas `bash` continua liberado — é convenção de fluxo, não
fronteira de segurança.

## Skills

| Skill | Pasta | Quando usar | Doc |
|---|---|---|---|
| _(nenhuma ainda)_ | — | — | — |

## Prompt templates

| Comando | Arquivo | Argumentos | Para que serve |
|---|---|---|---|
| _(nenhum ainda)_ | — | — | — |

## Instalar em outro PC

Três caminhos. **Escolha um por máquina** — usar dois ao mesmo tempo carrega a
mesma extensão duas vezes (o Pi avisa sobre o comando `/plan` duplicado).

### A. Como Pi package (não precisa clonar)

```bash
pi-bolt install git:github.com/edubrunaldi/pi-settings
pi-bolt list                      # confere
pi-bolt update --extensions       # atualiza depois de um push
```

O clone gerenciado pelo Pi fica em `~/.pi/agent/npm/`. Precisa que o repo esteja
publicado (push feito).

### B. Clonando o repo (repo = fonte da verdade)

Windows (PowerShell) / Linux e macOS:

```powershell
git clone https://github.com/edubrunaldi/pi-settings.git
cd pi-settings
.\scripts\install.ps1            # copia para ~/.pi/agent
.\scripts\install.ps1 -Link      # ou symlink (Windows: precisa de Developer Mode)
.\scripts\install.ps1 -DryRun    # só mostra o que faria
```

```bash
git clone https://github.com/edubrunaldi/pi-settings.git
cd pi-settings
./scripts/install.sh             # copia para ~/.pi/agent
./scripts/install.sh --link      # symlink, repo vira a fonte da verdade
./scripts/install.sh --dry-run
PI_AGENT_DIR=/caminho/do/agent ./scripts/install.sh
```

O script faz backup `*.bak-<timestamp>` do que sobrescreve, pula arquivos
idênticos e avisa se o repo também estiver instalado como package.

### C. Na mão

| Do repo | Para |
|---|---|
| `extensions/*.ts` | `~/.pi/agent/extensions/` |
| `skills/<nome>/` | `~/.pi/agent/skills/<nome>/` |
| `prompts/*.md` | `~/.pi/agent/prompts/` |
| `themes/*.json` | `~/.pi/agent/themes/` |
| `plan-flow/*.md` (sem `README.md`) | `~/.pi/agent/plan-flow/` |

### Depois de instalar

Reinicie o Pi ou rode `/reload` numa sessão aberta. Para conferir a extensão:

```text
/plan status
```

## Testar antes de instalar

```bash
npm run check      # testes de comportamento + load check com o loader real do Pi
```

Não precisa de `npm install`: `tests/run.mjs` copia os stubs de `tests/stubs/`
para `node_modules/` na primeira execução.

## O que não está (e não deveria estar) aqui

| Item | Por quê |
|---|---|
| `auth.json`, `models-store.json`, `sessions/`, `missions/` | credenciais, estado e histórico por máquina |
| `missions/`, `cache/`, `fff/`, `bin/` | artefatos gerados |
| pacotes npm de terceiros | instale com `pi-bolt install`, ou liste em `settings.json` → `packages` |

Sugestão de `settings.json` (não versionado, porque é por máquina):

```json
{
  "piBolt": {
    "packages": [
      "npm:opensec-pi-todo@2.13.1",
      "npm:opensec-pi-fff@0.11.0",
      "npm:opensec-pi-subagents"
    ]
  }
}
```

## Adicionar coisas novas

Estrutura, convenções e checklist por tipo de recurso: [AGENTS.md](AGENTS.md).
