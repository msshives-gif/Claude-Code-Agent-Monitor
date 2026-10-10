# Fork notes

This is the `msshives-gif` fork of [hoangsonww/Claude-Code-Agent-Monitor](https://github.com/hoangsonww/Claude-Code-Agent-Monitor), branch `improvements`. It tracks upstream releases by merge, one merge commit per release tag.

**Keep every `README*.md` identical to upstream.** Document fork-only behaviour here instead. Upstream rewrites its READMEs in most releases, and any fork edit to them conflicts on the next merge. The fork's other docs (`docs/`, `ARCHITECTURE.md`, `SETUP.md`, `wiki/`) still carry fork edits in place.

The sections below are what the fork adds to or changes in the README. Each language section mirrors the matching `README-*.md` from upstream.

Fork-only features covered here:

- **API-Equiv. Cost** label on the Dashboard cost card. Totals use provider API list prices, not subscription spend.
- **Context-fullness gauge** on Dashboard agent cards.
- **Tool-call roll-ups** in the Dashboard's recent activity feed.
- **Limits pill** on the Health tab. `rate_limit` throttling is reported there and left out of the error rate.
- Health tab refreshes every 30 seconds instead of 5.
- **Exact-first liveness probe** for dead-session reaping.
- **Payload trimming** before storage (`DASHBOARD_EVENT_STRING_CAP`, `DASHBOARD_EVENT_FIELD_CAP`, `npm run trim-events`).
- **compact-manager readout** panel (`DASHBOARD_COMPACT_MANAGER_BIN`).

## English (`README-EN.md`)

Features table, Dashboard row (replaces upstream's):

| Feature | Description |
|---|---|
| **Dashboard** | Persistent **Monitor** and **Health** tabs combine fleet totals, active hierarchies, recent activity, weighted success/cache/error/heap health, storage, tools, models, subagent effectiveness, and compaction metrics. The cost card reads **API-Equiv. Cost**: totals use provider API list prices (Anthropic for Claude, OpenAI for Codex), not subscription spend. Agent cards carry a **context-fullness gauge** (latest request's context occupancy vs the model window, amber at 70%, red at 90%). Recent activity collapses consecutive `PreToolUse`/`PostToolUse` runs into expandable "*N* tool calls · Read ×3, Bash ×2" rows; prompts, stops, errors, and notifications stay top-level. A **Limits** pill reports `rate_limit` throttling, which is excluded from the error rate. Health refreshes every 30 seconds from `/api/settings/info` and `/api/workflows`. |

How it works, liveness probe (replaces upstream's bullet):

- The same watchdog completes dead local sessions through a process-liveness probe after `DASHBOARD_LIVENESS_IDLE_SECONDS`, default 60. The probe is exact-first: for direct-loopback ingests the hook handler records the `claude` process that owns each session (with a start-time token that defeats PID reuse), so a live owner spares a session whose `cwd` drifted through in-session `cd`, and a verified-dead owner completes it even when an unrelated `claude` runs in the same directory. Rows without an owner identity (pre-upgrade or forwarded) fall back to matching `cwd` against running `claude` processes. Startup probes run immediately and again after about 5 seconds without that idle gate. The probe skips Windows, containers, non-POSIX forwarded paths, remote-source sessions, tool failures, and `DASHBOARD_LIVENESS_PROBE=0`; a later real hook self-heals a false completion.

Environment variables (added):

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_EVENT_STRING_CAP` | `2048` | Hook payloads are trimmed before storage in `events.data`: whole-file mirrors (`originalFile`, `file.content`, `file.base64`) and top-level `background_tasks` are dropped, and every string is cut to this many characters. Changes are noted under `data._trimmed` (**Trimmed on storage** in the event pane); the transcript on disk keeps the full text. `0` disables all trimming. |
| `DASHBOARD_EVENT_FIELD_CAP` | `16384` | Byte budget for a `tool_input` / `tool_response` still large after string trimming; over budget, only short scalars that fit are kept. `npm run trim-events` applies the same rules to older rows. |
| `DASHBOARD_COMPACT_MANAGER_BIN` | `compact-manager` (PATH) | Executable for the optional Dashboard **compact-manager readout** (`GET /api/compact-manager/status`). The panel appears only when the CLI responds. |

Scripts (added):

| Command | Description |
|---|---|
| `npm run trim-events` | Shrink `events.data` rows stored before payload trimming existed (dry run by default; `--yes --backup` to rewrite and VACUUM with the dashboard stopped) |

## 中文 (`README-CN.md`)

Features table, Dashboard row (replaces upstream's):

| Feature | Description |
|---|---|
| **Dashboard** | 持久化的 **Monitor** 和 **Health** 标签页汇总 Agent 总量、活跃层级、最近活动、加权的成功率/缓存/错误/堆内存健康度，以及存储、工具、模型、Subagent 效能和压缩指标。费用卡片标注为 **API-Equiv. Cost**，按提供方 API 标价计算（Claude 按 Anthropic、Codex 按 OpenAI），并非订阅实际支出。Agent 卡片带**上下文占用量表**（最新请求的上下文占用相对模型窗口，70% 琥珀、90% 红色）。近期活动将连续的 `PreToolUse`/`PostToolUse` 折叠为可展开的“*N* tool calls · Read ×3, Bash ×2”行，提示词、停止、错误和通知保留在顶层。用量限制 **Limits** 指示报告 `rate_limit` 限流，并从错误率中排除。Health 每 30 秒从 `/api/settings/info` 和 `/api/workflows` 刷新。 |

How it works, liveness probe (replaces upstream's bullet):

- 同一个看门狗会在 `DASHBOARD_LIVENESS_IDLE_SECONDS` 后通过进程存活探测完成已结束的本地会话，默认 60。探测优先精确检查：对直接 loopback 的 ingest，Hook Handler 会记录拥有每个会话的 `claude` 进程（附带可防 PID 复用的启动时间令牌），因此存活的属主会保留 `cwd` 因会话内 `cd` 而漂移的会话，经验证已死亡的属主即使同目录运行着无关的 `claude` 也会完成该会话；没有属主身份的行（升级前或转发而来）退回将 `cwd` 与运行中的 `claude` 进程匹配。启动探测会立即执行，并在约 5 秒后再次执行，不受该空闲门槛限制。探测会跳过 Windows、容器、转发的非 POSIX 路径、远程数据源会话、工具失败和 `DASHBOARD_LIVENESS_PROBE=0`；之后到达的真实 Hook 会自愈误判。

Environment variables (added):

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_EVENT_STRING_CAP` | `2048` | Hook 负载在写入 `events.data` 前会被裁剪：移除整文件副本（`originalFile`、`file.content`、`file.base64`）和顶层 `background_tasks`，每个字符串截断到此字符数。改动记录在 `data._trimmed`（事件详情中显示为**存储时已裁剪**）；磁盘上的转录保留完整文本。`0` 禁用全部裁剪。 |
| `DASHBOARD_EVENT_FIELD_CAP` | `16384` | 字符串裁剪后仍然过大的 `tool_input` / `tool_response` 的字节预算；超出时只保留能放下的短标量值。`npm run trim-events` 对旧行应用同样的规则。 |
| `DASHBOARD_COMPACT_MANAGER_BIN` | `compact-manager`（PATH 查找） | 可选 Dashboard **compact-manager 读数**（`GET /api/compact-manager/status`）所用的可执行文件。面板仅在 CLI 有响应时出现。 |

Scripts (added):

| Command | Description |
|---|---|
| `npm run trim-events` | 收缩在引入负载裁剪之前保存的 `events.data` 行（默认仅模拟；停止仪表板后用 `--yes --backup` 重写并 VACUUM） |

## Español (`README-ES.md`)

Features table, Dashboard row (replaces upstream's):

| Feature | Description |
|---|---|
| **Panel** | Las pestañas persistentes **Monitor** y **Salud** combinan totales del conjunto, jerarquías activas, actividad reciente, estado ponderado de éxito, caché, errores y heap, almacenamiento, herramientas, modelos, eficacia de subagentes y métricas de compactación. La tarjeta de costo se llama **API-Equiv. Cost**: los totales usan los precios de lista de la API del proveedor (Anthropic para Claude, OpenAI para Codex), no el gasto de suscripción. Las tarjetas de agentes incluyen un **indicador de llenado de contexto** (ocupación de contexto de la última solicitud frente a la ventana del modelo, ámbar al 70 %, rojo al 90 %). La actividad reciente colapsa las rachas consecutivas de `PreToolUse`/`PostToolUse` en filas expandibles «*N* tool calls · Read ×3, Bash ×2»; los prompts, stops, errores y notificaciones permanecen en el nivel superior. Un indicador **Limits** reporta la limitación `rate_limit`, que se excluye de la tasa de error. Salud se actualiza cada 30 segundos desde `/api/settings/info` y `/api/workflows`. |

How it works, liveness probe (replaces upstream's bullet):

- El mismo watchdog completa sesiones locales muertas mediante una comprobación de actividad del proceso después de `DASHBOARD_LIVENESS_IDLE_SECONDS`, predeterminado en 60. La comprobación prioriza la identidad exacta: en ingestas directas por loopback, el handler de hooks registra el proceso `claude` que posee cada sesión (con un token de hora de inicio que evita la reutilización de PID), de modo que un propietario vivo preserva una sesión cuyo `cwd` se desvió por un `cd` dentro de la sesión, y un propietario verificado como muerto la completa aunque otro `claude` no relacionado se ejecute en el mismo directorio. Las filas sin identidad de propietario (anteriores a la actualización o reenviadas) recurren a comparar `cwd` con los procesos `claude` en ejecución. Las comprobaciones al iniciar se ejecutan inmediatamente y de nuevo tras unos 5 segundos sin esa espera. La comprobación omite Windows, contenedores, rutas no POSIX reenviadas, sesiones de fuentes remotas, fallos de herramientas y `DASHBOARD_LIVENESS_PROBE=0`. Un hook real posterior corrige automáticamente una finalización falsa.

Environment variables (added):

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_EVENT_STRING_CAP` | `2048` | Las cargas de los hooks se recortan antes de guardarse en `events.data`: se eliminan las copias de archivo completo (`originalFile`, `file.content`, `file.base64`) y el campo de nivel superior `background_tasks`, y cada cadena se corta a este número de caracteres. Los cambios se anotan en `data._trimmed` (**Recortado al guardar** en el detalle del evento); la transcripción en disco conserva el texto completo. `0` desactiva todo el recorte. |
| `DASHBOARD_EVENT_FIELD_CAP` | `16384` | Presupuesto en bytes para un `tool_input` / `tool_response` que sigue siendo grande tras recortar cadenas; por encima, solo se conservan los escalares cortos que quepan. `npm run trim-events` aplica las mismas reglas a filas antiguas. |
| `DASHBOARD_COMPACT_MANAGER_BIN` | `compact-manager` (PATH) | Ejecutable para el panel opcional de **lectura de compact-manager** en el Panel (`GET /api/compact-manager/status`). El panel solo aparece cuando el CLI responde. |

Scripts (added):

| Command | Description |
|---|---|
| `npm run trim-events` | Reducir las filas de `events.data` guardadas antes de que existiera el recorte de cargas (simulación por defecto; `--yes --backup` para reescribir y hacer VACUUM con el panel detenido) |

## 한국어 (`README-KO.md`)

Features table, Dashboard row (replaces upstream's):

| Feature | Description |
|---|---|
| **Dashboard** | 저장되는 **Monitor**와 **Health** 탭이 전체 합계, 활성 계층, 최근 활동, 가중 성공률/캐시/오류/힙 상태, 스토리지, 도구, 모델, Subagent 효과, 컴팩션 지표를 결합합니다. 비용 카드는 **API-Equiv. Cost**로 표기되며 제공사 API 정가 기준 합계(Claude 세션은 Anthropic, Codex는 OpenAI 요율표)이고 구독 실지출이 아닙니다. 활성 에이전트 카드에는 **컨텍스트 사용량 게이지**(최신 요청의 컨텍스트 점유량 대 모델 윈도우, 70%에서 앰버, 90%에서 적색)가 표시됩니다. 최근 활동은 연속된 `PreToolUse`/`PostToolUse`를 확장 가능한 "*N* tool calls · Read ×3, Bash ×2" 행으로 접고, 프롬프트, 중지, 오류, 알림은 최상위에 유지합니다. **Limits** 항목은 `rate_limit` 스로틀링을 보고하며 오류율에서 제외됩니다. Health는 `/api/settings/info`와 `/api/workflows`에서 30초마다 새로 고칩니다. |

How it works, liveness probe (replaces upstream's bullet):

- 같은 watchdog은 `DASHBOARD_LIVENESS_IDLE_SECONDS`, 기본값 60 이후 process-liveness probe로 종료된 local session을 완료합니다. Probe는 exact-first입니다. 직접 loopback ingest에서는 hook handler가 각 세션을 소유한 `claude` 프로세스를(PID 재사용을 막는 시작 시각 토큰과 함께) 기록하므로, 살아 있는 소유자는 세션 내 `cd`로 `cwd`가 어긋난 세션을 보존하고, 사망이 확인된 소유자는 같은 디렉터리에 무관한 `claude`가 실행 중이어도 세션을 완료합니다. 소유자 신원이 없는 행(업그레이드 이전 또는 forwarded)은 `cwd`를 실행 중인 `claude` 프로세스와 매칭하는 방식으로 되돌아갑니다. 시작 probe는 즉시 실행되고 약 5초 후 이 idle gate 없이 다시 실행됩니다. Probe는 Windows, container, non-POSIX forwarded path, remote-source session, tool failure, `DASHBOARD_LIVENESS_PROBE=0`에서 건너뛰며, 이후 실제 Hook이 잘못된 완료를 자동 복구합니다.

Environment variables (added):

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_EVENT_STRING_CAP` | `2048` | Hook 페이로드는 `events.data`에 저장되기 전에 축약됩니다. 전체 파일 사본(`originalFile`, `file.content`, `file.base64`)과 최상위 `background_tasks`는 제거되고, 모든 문자열은 이 글자 수로 잘립니다. 변경 내용은 `data._trimmed`에 기록되며(이벤트 창의 **저장 시 축약됨**), 디스크의 트랜스크립트에는 전체 텍스트가 남습니다. `0`은 모든 축약을 끕니다. |
| `DASHBOARD_EVENT_FIELD_CAP` | `16384` | 문자열 축약 후에도 큰 `tool_input` / `tool_response`의 바이트 예산입니다. 초과하면 예산에 맞는 짧은 스칼라 값만 남깁니다. `npm run trim-events`는 같은 규칙을 이전 행에 적용합니다. |
| `DASHBOARD_COMPACT_MANAGER_BIN` | `compact-manager` (PATH) | 선택적 Dashboard **compact-manager 판독**(`GET /api/compact-manager/status`)에 사용할 실행 파일입니다. CLI가 응답할 때만 패널이 표시됩니다. |

Scripts (added):

| Command | Description |
|---|---|
| `npm run trim-events` | 페이로드 축약이 도입되기 전에 저장된 `events.data` 행을 축소합니다 (기본은 시험 실행; 대시보드를 중지한 뒤 `--yes --backup`으로 재작성 및 VACUUM) |

## Tiếng Việt (`README-VN.md`)

Features table, Dashboard row (replaces upstream's):

| Feature | Description |
|---|---|
| **Dashboard** | Hai tab **Monitor** và **Health** được lưu bền vững, kết hợp tổng số Agent (thẻ chi phí ghi nhãn **API-Equiv. Cost** — tổng theo giá niêm yết API của nhà cung cấp, biểu giá Anthropic cho Claude, biểu giá OpenAI cho Codex, không phải chi tiêu thuê bao), hệ thống phân cấp đang hoạt động với **thước đo độ đầy ngữ cảnh** (mức chiếm dụng ngữ cảnh của yêu cầu mới nhất so với cửa sổ của mô hình, hổ phách tại 70%, đỏ tại 90%), hoạt động gần đây (các chuỗi `PreToolUse`/`PostToolUse` liên tiếp được gộp thành hàng có thể mở rộng "*N* tool calls · Read ×3, Bash ×2"; prompt, stop, lỗi và thông báo vẫn ở cấp cao nhất), sức khỏe có trọng số theo thành công/cache/lỗi/heap cùng ô **Limits** (thông báo `rate_limit` được báo cáo ở đó và loại khỏi tỷ lệ lỗi), lưu trữ, công cụ, model, hiệu quả Subagent và chỉ số compaction. Health làm mới mỗi 30 giây từ `/api/settings/info` và `/api/workflows`. |

How it works, liveness probe (replaces upstream's bullet):

- Cùng watchdog đó hoàn tất phiên cục bộ đã chết bằng kiểm tra liveness tiến trình sau `DASHBOARD_LIVENESS_IDLE_SECONDS`, mặc định 60. Probe ưu tiên kiểm tra chính xác: với các ingest loopback trực tiếp, hook handler ghi nhận tiến trình `claude` sở hữu mỗi phiên (kèm token thời-điểm-khởi-động chống tái sử dụng PID), nên chủ sở hữu còn sống giữ lại phiên có `cwd` bị lệch do `cd` trong phiên, còn chủ sở hữu đã chết được xác minh sẽ hoàn tất phiên kể cả khi một `claude` không liên quan chạy cùng thư mục. Các hàng không có danh tính chủ sở hữu (trước nâng cấp hoặc được chuyển tiếp) quay về cách khớp `cwd` với các tiến trình `claude` đang chạy. Kiểm tra khi khởi động chạy ngay lập tức và chạy lại sau khoảng 5 giây mà không áp dụng ngưỡng idle. Kiểm tra bỏ qua Windows, container, đường dẫn chuyển tiếp không phải POSIX, phiên nguồn từ xa, lỗi công cụ và `DASHBOARD_LIVENESS_PROBE=0`; hook thật về sau tự sửa một lần hoàn tất sai.

Environment variables (added):

| Variable | Default | Description |
|---|---|---|
| `DASHBOARD_EVENT_STRING_CAP` | `2048` | Payload hook được cắt bớt trước khi lưu vào `events.data`: bản sao toàn bộ tệp (`originalFile`, `file.content`, `file.base64`) và `background_tasks` cấp cao nhất bị loại bỏ, mọi chuỗi bị cắt còn chừng này ký tự. Thay đổi được ghi tại `data._trimmed` (**Đã cắt bớt khi lưu** trong chi tiết sự kiện); transcript trên đĩa vẫn giữ toàn bộ văn bản. `0` tắt toàn bộ việc cắt bớt. |
| `DASHBOARD_EVENT_FIELD_CAP` | `16384` | Ngân sách byte cho một `tool_input` / `tool_response` vẫn còn lớn sau khi cắt chuỗi; vượt ngân sách thì chỉ giữ các giá trị vô hướng ngắn vừa đủ. `npm run trim-events` áp dụng cùng quy tắc cho các hàng cũ. |
| `DASHBOARD_COMPACT_MANAGER_BIN` | `compact-manager` (tra PATH) | Tệp thực thi cho bảng **compact-manager readout** tùy chọn trên Dashboard (`GET /api/compact-manager/status`). Bảng chỉ xuất hiện khi CLI phản hồi. |

Scripts (added):

| Command | Description |
|---|---|
| `npm run trim-events` | Thu gọn các hàng `events.data` được lưu trước khi có cắt bớt payload (mặc định chạy thử; `--yes --backup` để ghi lại và VACUUM khi dashboard đã dừng) |
