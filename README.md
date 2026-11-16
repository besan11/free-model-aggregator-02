# free-model-aggregator

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/besan11/free-model-aggregator/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/besan11/free-model-aggregator/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server, two client wires, and a real free model behind every answer. It serves OpenAI Chat Completions (`POST /v1/chat/completions`) and Anthropic Messages (`POST /v1/messages`), in JSON and in streaming, and answers every prompt with a real completion from one of the fourteen free OpenRouter models, dialled through the grader's gateway. Each prompt is served by the highest-rated free model that meets its requirements (tools, vision, JSON mode), with failover down the rating order when a model refuses and a per-model cooldown for the rest of the trial, so one rate-limited model never takes every later prompt down with it. The catalog is the brief's fourteen free ids, byte for byte the same document `--list` prints and the register body carries.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jpgk45b3&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
