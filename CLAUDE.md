# CLAUDE.md — lore

Guia para agentes de IA (e humanos) trabalhando neste repositório. Leia antes de
implementar qualquer task.

## O que é

`lore` é uma CLI que monitora issues de vários repositórios do GitHub. Mantém um
espelho local incremental, detecta o que mudou desde a última sincronização, e
oferece uma camada de compactação (resumos estruturados) produzida e consumida
por IAs. O nome é a *lore*: o conhecimento acumulado e destilado das issues de um
projeto.

- Pacote npm: `@merencia/lore` · binário: `lore`
- Estado local: `~/.lore/db.sqlite` (override por `LORE_HOME`)
- Auth: `GITHUB_TOKEN` no ambiente · base URL via `GITHUB_API_URL` (Enterprise)

## Princípios (não violar)

1. **Núcleo útil sem IA.** Espelho local + detecção de mudança + digest funcionam
   sozinhos. A compactação é uma camada opcional por cima. O núcleo nunca depende
   da compactação.
2. **A tool é burra; a IA é a CPU da compactação.** A ferramenta NÃO chama nenhum
   LLM. Ela armazena conteúdo cru, expõe o que precisa ser compactado e recebe o
   resumo de volta. Quem resume é o agente que consome a tool.
3. **Não buscar duas vezes.** Sync incremental com `since` + ETag (`304` não gasta
   rate limit). Comentários só são baixados sob demanda.
4. **Raw nunca é apagado.** Compactar não remove o cru. O ganho da compactação é
   token de contexto na hora de consumir, não espaço em disco.
5. **Saída dupla.** Todo comando tem saída humana e `--json`. A lógica não acopla
   na camada de print.
6. **O usage é protocolo.** O texto de uso descreve o contrato que a IA segue. É
   máquina-legível, não decorativo.
7. **Multi-repo é first-class.** A unidade é o conjunto de repos observados.
   `sync` percorre todos; `digest` é um inbox agregado.

## Arquitetura

```
src/
  cli.ts            entrypoint (shebang via rollup banner) -> createProgram().parseAsync
  program.ts        monta o Command raiz e chama registerCommands
  commands/         um arquivo por comando; index.ts registra todos (merge point)
  github/           cliente REST: listIssues (since+ETag), getComments (on-demand)
  store/            SQLite (better-sqlite3), migrations, acesso tipado
  sync/             diff de snapshot -> upsert + eventos + compact_stale
  render/           human vs json a partir da mesma fonte de dados
  protocol/         texto do contrato de compactação
```

Comandos: `add`, `remove`, `list`, `sync`, `digest`, `repo-digest`, `show`,
`compact (list|set)`, `protocol`. Detalhes e schema do SQLite estão em
`.local/PLAN.md` e `.local/TASKS.md` (pasta ignorada pelo git; é a fonte de
verdade do escopo).

## Protocolo de compactação (contrato para IAs)

Cada issue exposta tem `compact` (string|null) e `compact_stale` (bool).

1. `compact != null` E `compact_stale == false` → **USE o compact.** Não leia o
   raw, não recompacte.
2. `compact == null` OU `compact_stale == true` → leia `raw_body` +
   `raw_comments`, escreva um resumo no formato canônico e persista com
   `lore compact set <owner/repo>#<n> --from-file <arquivo>`. Isso zera o stale.

Formato canônico do compact (frontmatter copiado da API + corpo escrito pela IA):

```
---
status: open | closed
state_reason: completed | not_planned | null   # da API, NÃO inventar
refs: ["#812", "owner/repo#45", "PR #820"]
versions: { affected: "...", fixed: "..." }    # só se mencionado
labels: [bug, timezone]                         # só os que dão sinal
---
tldr: <uma frase, <= ~20 palavras>

problem: <o que está errado / sendo pedido>
status_detail: <onde está: bloqueado em X / aguardando repro / fixado em vN>
decisions: <o que foi decidido e por quê | null>
open_questions: <o que ficou em aberto | null>
```

`status`, `state_reason` e `labels` são copiados da API, nunca interpretados. A IA
preenche só os campos textuais. Campo textual vazio é `null`. Refs preservadas
literais. Soft cap ~8 linhas no corpo. Não inventar `state_reason`.

Especificação canônica completa (campo a campo, regras e exemplos):
[docs/compact-format.md](./docs/compact-format.md).

## Estilo de código (segue sidequest + node-cron)

- **TypeScript ESM.** `"type": "module"`. Imports de builtins com prefixo `node:`.
  Imports relativos terminam em `.js` (NodeNext-friendly). JSON via
  `with { type: "json" }`.
- **Arquivos em kebab-case** (`run-coordinator.ts`, `time-matcher.ts`).
- **PascalCase** para classes/types/interfaces, **camelCase** para funções/vars.
- `index.ts` como barrel por pasta quando fizer sentido.
- **Testes co-locados** como `*.test.ts` ao lado do código, Vitest (`globals`).
- **JSDoc** na API pública (estilo node-cron).
- **Console é permitido** (é uma CLI; a saída é a interface). Sem `no-console`.
- Prettier: aspas duplas, ponto-e-vírgula, `trailingComma: all`, 120 colunas,
  2 espaços. Rode `npm run format` antes de commitar.

### Ferramentas

| | |
|---|---|
| Package manager | **npm** (`npm ci` no CI) |
| Build | **Rollup** (`npm run build`) → `dist/cli.js` ESM com shebang |
| Lint | **ESLint flat** + typescript-eslint recommended (`npm run lint`) |
| Format | **Prettier** (`npm run format` / `format:check`) |
| Types | `tsc --noEmit` (`npm run typecheck`) |
| Test | **Vitest** + coverage v8 (`npm test`) |
| Node | engines `>=20`; CI matrix 20/22/24 |

## Quality gate (precisa passar antes de qualquer PR)

```
npm run check   # lint + format:check + typecheck + test
npm run build   # o bundle precisa compilar
```

O CI (`.github/workflows/ci.yml`) roda exatamente isso: `static` (lint, format,
types) + `test` na matrix com build. Um PR só é mergeável com o CI verde.

## Fluxo de contribuição (para os agentes do pipeline)

1. Cada task vive num worktree próprio, em uma branch `task/<id>-<slug>`.
2. Implemente a task respeitando os princípios e o estilo acima.
3. Garanta `npm run check` e `npm run build` verdes localmente.
4. Abra um PR contra `main` com título no formato Conventional Commits
   (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
5. Um revisor (`/pair-with merencia`) comenta no PR. Corrija até passar.
6. Sem atribuição a IA em commits, PRs ou comentários. Sem em dash (`—`).
