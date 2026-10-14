# build

docker build -f docker/Dockerfile -t agata-server --progress=plain .

# run (use docker/.env — host services via host.docker.internal, not localhost)

docker run --rm -it --env-file docker/.env -p 4000:4000 agata-server

# personas

A persona bundles the knowledge base and answering behaviour for one audience
(Agata, the foundation, the church, …). They are defined in
`src/config/personas.ts` — that file is the single source of truth.

Per persona you configure:

| Field                    | Meaning                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `collection`             | Qdrant collection queried on the RAG server                                            |
| `ragTopK`                | Chunks requested per question                                                          |
| `webResultCount`         | Web results when RAG found something; `0` disables web search                          |
| `webFallbackResultCount` | Web results when RAG found nothing; `0` disables the fallback                          |
| `language`               | `hsb`, `de`, or `auto` (answer in the language of the question)                        |
| `allowGeneralKnowledge`  | When `false` the assistant says "no sources" instead of answering from model knowledge |
| `description`            | Persona text injected into the LLM system prompt                                       |

Adding a persona means adding an entry here and filling its collection via the
RAG server's parse endpoints (`collection=…`). Both must match.

`GET /api/personas` returns the public subset (id, label, language, whether web
search is on) so the frontend can show labels without knowing prompt internals.

`POST /api/chat` accepts `persona` in the body. Unknown or missing ids fall back
to `agata`, so old clients keep working. A short slug such as `schule` is
resolved to the managed persona stored under that name. A 24-character id that
belongs to a managed persona is resolved from MongoDB as well. Private managed
personas addressed by that internal id return 403 on this open endpoint.

## Managed personas

Administrators can create additional personas in MongoDB (`personas` and
`personaDocuments`). Each one gets its own Qdrant collection
`persona_<id>` on the RAG server, so uploads, search and deletion never share
chunks with another persona or with the static collections above.

Set `ADMIN_TOKEN` in the server environment. The React page
`/admin/personas` sends it as `Authorization: Bearer …`. Each managed persona
has a short slug for the webview (`/?persona=schule`) and a separate secret
token for the document link (`/persona/<token>`). The slug is editable in the
admin page and unique in MongoDB. `MONGODB_URI` stays server-side.

The RAG server must expose `POST /documents`, `DELETE /documents` and
`DELETE /collections/{name}` (see `rag-server-scaffold/README.api.md`).

# chat logs

Set `CHAT_LOG_MODE` in `.env`:

| Value  | Behaviour                                                                   |
| ------ | --------------------------------------------------------------------------- |
| `none` | No chat pipeline logs (default)                                             |
| `rag`  | Compact block: persona, question, RAG hits with match %, AI sources, answer |
| `all`  | Full timing/provider logs plus the compact RAG summary                      |

`CHAT_TIMING_ENABLED=true` still works and is treated as `all`.
