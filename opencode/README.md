# VikiEditor for OpenCode

실행 중인 OpenCode 세션이 VikiEditor에서 일어나는 일을 바로 듣습니다:

- **Feedback**: 누군가 에이전트가 쓴 문서에 댓글을 남기면(또는 다시 물으면), 세션이 한가해진 순간 그 내용이 프롬프트로 들어가고, 에이전트가 스레드를 take → 문서를 고치고 → reply 합니다. 터미널에서 부탁하지 않아도 됩니다.
- **Handoff**: 누군가 다음 세션에 넘긴 작업을 같은 방식으로 이어받습니다.
- **폰에서 도구 승인** (permission relay): 세션이 도구 실행 허락을 기다릴 때 VikiEditor가 알림을 보내고, 앱에서 allow / deny 하면 OpenCode에 그대로 적용됩니다. 10분 안에 답이 없으면 터미널 프롬프트에 맡깁니다.

플러그인은 이벤트만 전달합니다. 실제 작업은 VikiEditor MCP 서버의 도구(`feedback`, `handoff`, `update_document` …)로 하니 MCP 서버도 함께 연결하세요. [Claude Code 채널 플러그인](../README.md)과 같은 서버 엔드포인트, 같은 환경변수, 같은 `.vikieditor.json` 규칙을 씁니다.

## 설치

1. VikiEditor에서 **Settings → Connections → Create New Key**. 키(`vk_…`)를 복사합니다.
2. VikiEditor MCP 서버를 OpenCode에 연결합니다 (아직이라면). `opencode.json`(프로젝트 루트 또는 `~/.config/opencode/opencode.json`):

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "vikieditor": {
         "type": "remote",
         "url": "https://vikieditor.piai.company/api/mcp",
         "headers": { "Authorization": "Bearer vk_YOUR_KEY" },
         "oauth": false,
         "enabled": true
       }
     }
   }
   ```

   API 키 대신 OAuth로 붙이려면 `headers`를 빼고 `"oauth": {}`로 두면 처음 쓸 때 브라우저 로그인을 안내합니다.

3. 이 저장소를 받아 둡니다: `git clone https://github.com/diasm3/vikieditor-claude ~/vikieditor-claude` (업데이트는 그 폴더에서 `git pull`).

   그리고 이 플러그인을 `opencode.json`의 `plugin`에 추가합니다. clone한 경로를 `file://` 절대경로로 씁니다:

   ```json
   {
     "plugin": ["file:///Users/you/vikieditor-claude/opencode/index.mjs"]
   }
   ```

   - OpenCode 1.18 이후는 디렉터리(`file:///…/vikieditor-claude/opencode`, `package.json`의 `main`을 읽음)와 옵션 튜플도 받습니다: `["file:///…/index.mjs", { "session": "vikieditor" }]` (`session`, `url`, `apiKey`; 환경변수가 우선).
   - 프로젝트의 `.opencode/plugins/`에 두고 싶으면 **`.js`로** 링크합니다. OpenCode는 그 폴더에서 `*.ts`/`*.js`만 읽습니다:
     `ln -s /…/vikieditor-claude/opencode/index.mjs .opencode/plugins/vikieditor.js` (`lib.mjs`가 옆에 있어야 하므로 복사 대신 링크).
   - npm 패키지로 발행되면 `"plugin": ["@vikieditor/opencode-plugin"]` 한 줄이면 됩니다 (아직 발행 전).

4. API 키를 환경변수로 주고 OpenCode를 시작합니다:

   ```bash
   export VIKIEDITOR_API_KEY=vk_YOUR_KEY
   opencode
   ```

   듣는 동안 세션이 VikiEditor **Settings → Connections**에 나타납니다. 세션 이름은 OpenCode를 실행한 폴더 이름이고, `VIKIEDITOR_SESSION`으로 바꿀 수 있습니다. 같은 이름의 두 번째 창은 `-2`, `-3` … 을 받습니다. 연결되면 TUI에 "Connected as session …" 토스트가 뜹니다.

## 동작

- 플러그인이 로드되면 `GET /api/agent-events` 스트림을 열고(API 키 Bearer), 끊기면 1초 → 최대 60초 백오프로 다시 붙습니다. 1분마다 `POST /api/agent-events/streams/:id/alive`로 살아 있음을 알립니다.
- feedback / handoff 이벤트는 **큐에 쌓입니다** (같은 스레드·같은 핸드오프는 하나로 합쳐지고, 같은 내용이 1분 안에 다시 오면 무시). 도착할 때마다 TUI 토스트가 뜹니다.
- 사람이 마지막으로 쓴 최상위 세션(서브에이전트 세션 제외)이 **idle일 때만** 큐 전체를 **프롬프트 하나**로 넣습니다 (`POST /session/:id/prompt_async`). 턴이 돌고 있으면 `session.idle`까지 기다립니다. 우리가 넣은 프롬프트로 시작된 턴이 끝나기 전에는 다음 것도 넣지 않습니다.
- 프롬프트에는 기다리는 항목의 8자리 id와 써야 할 도구가 들어갑니다: `feedback action=take commentId=…` → 문서 수정 → `feedback action=reply`, `handoff action=take id=…` → 작업 → `handoff action=done`. 그리고 아직 안 했다면 VikiEditor `session` 도구를 이 세션 이름으로 먼저 부르라고 합니다 (그래야 이 세션이 쓴 문서의 피드백이 다시 이 세션으로 옵니다).
- **`targetSession`**: 서버가 이벤트에 `targetSession`(행동할 세션 이름, 또는 `null`)을 붙여 보내면, 그 이름이 이 세션과 다를 때는 프롬프트를 넣지도 스레드를 take하지도 않고 토스트와 로그로만 알립니다. 필드가 없거나 `null`이면 예전처럼 이 세션이 처리합니다.
- **권한 릴레이**: OpenCode가 도구 승인을 기다리기 시작하면(`permission.asked`) 같은 내용을 `POST /api/agent-events/permissions`로 보냅니다 (`stream`, 5글자 `request_id`, `tool_name`, `description`, `input_preview`). 폰에서 답하면 스트림으로 `permission` 이벤트가 오고, `allow` → `once`, `deny` → `reject`로 `POST /session/:id/permissions/:permissionID`에 적용합니다. 터미널에서 먼저 답했으면(`permission.replied`) 폰의 늦은 답은 버립니다. 10분(서버가 요청을 잊는 시간)이 지나면 플러그인도 잊습니다.
- 로그는 stderr에만, 연결/끊김/오류 몇 줄만 씁니다. 접두어 `[vikieditor-opencode]`.

## 여러 세션: 누가 어느 피드백을 받나

여러 OpenCode 창(tmux, 여러 저장소)이 듣고 있으면, 댓글은 그 문서를 아는 세션에게 갑니다:

1. 스레드를 take한 세션;
2. 없으면 그 문서를 마지막으로 쓴 세션 (에이전트가 MCP 세션 이름을 이 플러그인의 세션 이름과 같게 부르므로);
3. 없으면 **scope**가 그 문서를 덮는 세션들 (폴더 또는 태그);
4. 없으면 scope 없는 세션들.

아무도 맞지 않으면 어느 세션이 take할 때까지 기다립니다. 문서가 없는 이벤트(문서 없는 handoff)는 모든 세션에 갑니다.

scope는 저장소 루트의 `.vikieditor.json`에 둡니다 (플러그인은 작업 폴더와 그 위를 찾습니다). 그러면 그 저장소의 모든 창이 같은 값을 갖습니다:

```json
{ "session": "vikieditor", "folders": ["VikiEditor"], "tags": ["vikieditor"] }
```

- `folders`: 문서 id(또는 앞 8자) 또는 `VikiEditor/Design` 같은 제목 경로. 그 아래 전부가 포함됩니다.
- `tags`: 이 태그 중 하나를 가진 문서가 포함됩니다.
- `session`: 폴더 이름 대신 쓸 세션 이름.

창 하나만이라면 `VIKIEDITOR_SCOPE="folder:VikiEditor,tag:vikieditor"`. 라우팅은 서버가 하며, 연결 시 `ready` 이벤트로 돌아온 scope(찾지 못한 폴더 포함)를 로그에 남깁니다.

## 설정

| 변수 | 기본값 | |
|---|---|---|
| `VIKIEDITOR_API_KEY` | (필수) | 내 키 |
| `VIKIEDITOR_URL` | `https://api.piai.company` | 자체 호스팅이면 VikiEditor API 호스트 |
| `VIKIEDITOR_SESSION` | `.vikieditor.json`의 `session`, 없으면 작업 폴더 이름 | VikiEditor에 보이는 세션 이름 |
| `VIKIEDITOR_SCOPE` | `.vikieditor.json`의 `folders`/`tags` | `folder:A,tag:b` 또는 JSON; 이 세션이 돌보는 범위 |

Node.js 18 이상 또는 Bun. 런타임 의존성 없음. `devDependencies`의 `@opencode-ai/plugin`, `@opencode-ai/sdk`는 타입 참조용입니다.

## 테스트

```bash
cd opencode
node --test
```

가짜 OpenCode 클라이언트·가짜 이벤트 스트림·가짜 타이머로 큐/중복 제거, idle에서만 주입, 프롬프트 내용, `targetSession`, 권한 릴레이(정상·타임아웃·터미널 선답), scope 전달을 확인합니다.

### 수동 확인 (실제 OpenCode)

```bash
mkdir -p /tmp/viki-smoke && cd /tmp/viki-smoke
cat > opencode.json <<EOF
{ "plugin": ["file://$HOME/vikieditor-claude/opencode/index.mjs"] }
EOF
echo '{ "session": "viki-smoke" }' > .vikieditor.json
VIKIEDITOR_API_KEY=vk_YOUR_KEY opencode serve --port 4097 --print-logs
```

- stderr에 `[vikieditor-opencode] connected to https://api.piai.company as session "viki-smoke"`가 나오고, VikiEditor Settings → Connections에 `viki-smoke`가 보이면 연결 OK.
- 다른 터미널에서 세션을 만들고 idle로 둔 뒤(`opencode attach http://127.0.0.1:4097` 또는 TUI), VikiEditor에서 에이전트가 쓴 문서에 댓글을 남기면 세션에 "VikiEditor: one item is waiting …" 프롬프트가 들어가야 합니다.
- 세션이 도구 승인을 기다릴 때 폰 알림이 오고, 앱에서 allow 하면 도구가 실행되어야 합니다.

## 알아둘 것

- 프롬프트는 세션이 idle이면 사람이 입력창에 뭔가 쓰고 있어도 들어갑니다 (OpenCode는 "입력 중"을 알려주지 않습니다).
- 폰의 `allow`는 이번 한 번(`once`)만 허용합니다. "항상 허용"은 터미널에서.
- `opencode serve`만 떠 있고 세션이 하나도 없으면, 첫 세션이 생길 때까지 큐에 둡니다.
