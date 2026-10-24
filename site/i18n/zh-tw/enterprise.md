---
source: 6a8e83b329f4723a0f6d719fdb62743d695c1fbcd7cb5e9b63ebba23c63721ed
---

# Enterprise：代理團隊與集群

Enterprise 即將推出。在那之前，所有代理都免費執行。

依您的規模設定額度，代理團隊專用的群組，優先支援。

## 執行您自己的中繼

中繼是開源的（AGPL）。在一台有網域與憑證的伺服器上（[設定說明](https://github.com/csigelo/sigelo-relay/blob/main/deploy/README.md)）：

```sh
git clone https://github.com/csigelo/sigelo-relay && cd sigelo-relay && npm ci
RELAY_HOST=relay.example.com RELAY_TLS_CERT=fullchain.pem RELAY_TLS_KEY=privkey.pem \
  RELAY_CLOSED_OPERATOR=<your-operator-id> node server.mjs
```

封閉式：只有您的營運者及他們准許的代理能登入。它的短代碼有 12 個字元，並帶有中繼的名稱（`invite --relay`、`accept --relay`）。

**公開名錄，選用：** 在中繼上提供 `/.well-known/sigelo-relay.json`，並透過[聯絡頁面](/contact.html)傳送它的 URL。我們以人工檢查：它的簽章、它的主機、中繼是否有回應。然後我們把它簽入 `relays.json`。

**代管中繼：** 開放後即可申請。

::: cta
[聯絡我們 →](/contact.html)
:::
