# SynthScope

Smart Scan, live trade plans and backtests for Deriv's synthetic indices (Vixed Indices), as a web app you can install on Android and as an APK.

SynthScope reads Deriv's public price feed. It never logs in to your Deriv account and never places trades.

## What it does

SynthScope calls Deriv's synthetic indices **Vixed Indices**.

- **Smart Scan** backtests all 13 strategies on every Vixed index and every timeframe you pick (1 minute to 1 day). It finds the strategy that has worked best on each one and shows its live signals as cards with entry, stop loss, TP1, TP2, dollar risk and MT5 lot size. With live mode on, it rescans after every candle closes.
- **Chart** shows live candles, the selected strategy's signals and the active trade plan as lines. "Best here" ranks the top 3 strategies for that market right now, and it can check all 12 timeframes at once.
- **Strategies** holds the library and a backtester that trades each strategy with the app's own stops and targets.
- **Alerts** watch up to 20 market and timeframe pairs, alert with sound, vibration and a notification, and forward test every alert until it hits the stop, TP1 or the max hold.

## Strategy library

The top 5, ranked by how often each setup appears across trader forums, the Deriv community and strategy guides:

| # | Strategy | Rules | Best for |
|---|---|---|---|
| 1 | RSI 50 + MA 21 Momentum | RSI 14 above 50 and close above the 21 EMA (mirror for sells) | Volatility, Jump, Step |
| 2 | Spike Rider (EMA 200 + RSI 14) | Above the 200 EMA, RSI under 30, two red candles (mirror for sells) | Boom, Crash |
| 3 | Spike Catcher (EMA 5/15 + Stochastic) | EMA 5/15 cross with %K under 20 or over 80 in the last 3 candles | Boom, Crash, Volatility |
| 4 | Triple EMA 21/55/89 + MACD | EMAs stacked, ADX over 20, MACD crosses its signal line | Volatility, Drift, Step |
| 5 | EMA 50 Pullback | Rising 50 EMA, price touches it, rejection candle closes back above | Volatility, Step, Boom/Crash |

Plus 7 classic tools (EMA 9/21, EMA 50/200, Supertrend, MACD, RSI, Bollinger, Stochastic) and a combined score of the classic tools weighted by ADX.

On Boom only buys are taken and on Crash only sells, because that is the spike direction. This can be turned off in Settings.

## Trade plans

- **Entry:** the live price when the signal fires on a closed candle.
- **Stop loss (smart mix):** just beyond the nearest swing low or high of the last 10 candles when that sits 0.8 to 3 ATR away, otherwise 1.5 ATR.
- **Take profit:** TP1 at 1.5 times the risk, TP2 at 3 times.
- **Size:** risk is a percent of the balance you enter (2% by default). MT5 lots = risk / stop distance, assuming contract size 1.

## How strategies are scored

Every backtest trade uses the plan above and exits at the stop, TP1, or the max hold. Results are compared with a coin-flip trader using the same stops and targets on the same market, which catches the Boom/Crash trap where a high win rate still loses money.

The **edge score** (0 to 100) comes from the z score of that edge, corrected for picking the best of 13 strategies (testing many and keeping the winner makes luck look like skill). 65+ is promising, and 85+ needs a corrected z of 3 with a positive edge in both halves of the history. Fewer than 20 trades scores 0. On random price series, fewer than 3 in 100 markets reach 65 and about 3 in 1,000 reach 85. A planted real trend scores 100.

## 24/7 scanner and phone alerts (GitHub Actions + ntfy)

`server/scan.js` runs on GitHub's servers every 5 minutes, even when your phone is off. Each run loads every Vixed index on 5m, 15m, 30m and 1h, ranks all 13 strategies with the same engine as the app, and sends a push alert through the free [ntfy](https://ntfy.sh) app for each fresh signal whose edge score is 70 or more. Every alert shows the entry, stop loss, TP1, TP2, dollar risk and MT5 lots. The scanner then follows each alert and sends a result message when it hits the stop or TP1, with your running forward record.

GitHub runs scheduled jobs every 5 to 15 minutes, so 1 to 3 minute timeframes are left out by default. Always check the live price before you enter.

**Setup**
1. Install ntfy from the Play Store and subscribe to a topic with a long random name. Anyone who knows the name can read the alerts.
2. In this repo: **Settings > Secrets and variables > Actions > New repository secret**. Name `NTFY_TOPIC`, value = your topic name.
3. Create the file `.github/workflows/scanner.yml` with the contents below (**Add file > Create new file**). GitHub only lets you add workflow files yourself.
4. **Actions > 24-7 scanner > Run workflow** to test it. Each run's summary lists the top markets and your forward record.

```yaml
name: 24-7 scanner

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

concurrency:
  group: scanner
  cancel-in-progress: false

jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 12
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Load scanner memory
        uses: actions/cache/restore@v4
        with:
          path: scan-state.json
          key: scan-state-${{ github.run_id }}
          restore-keys: scan-state-

      - name: Scan Vixed indices and send alerts
        run: node server/scan.js
        env:
          NTFY_TOPIC: ${{ secrets.NTFY_TOPIC }}
          SCAN_TIMEFRAMES: ${{ vars.SCAN_TIMEFRAMES }}
          MIN_SCORE: ${{ vars.MIN_SCORE }}
          MAX_ALERTS: ${{ vars.MAX_ALERTS }}
          BALANCE: ${{ vars.BALANCE }}
          RISK_PCT: ${{ vars.RISK_PCT }}
          MARKETS: ${{ vars.MARKETS }}

      - name: Save scanner memory
        if: always()
        uses: actions/cache/save@v4
        with:
          path: scan-state.json
          key: scan-state-${{ github.run_id }}
```

**Optional settings** (Settings > Secrets and variables > Actions > Variables tab):

| Variable | Default | Meaning |
|---|---|---|
| `MIN_SCORE` | 70 | Lowest edge score that sends an alert |
| `SCAN_TIMEFRAMES` | 300,900,1800,3600 | Timeframes in seconds |
| `MAX_ALERTS` | 6 | Most alerts per run |
| `BALANCE` | 100 | Account balance for the risk figure |
| `RISK_PCT` | 2 | Percent risked per trade |
| `MARKETS` | all | Comma list of families: volatility, boom, crash, jump, step, range, drift |

GitHub pauses scheduled workflows after 60 days with no commits to the repo. It emails you first, and one click on **Enable workflow** turns it back on.

## Project layout

```
www/                 the web app (this folder is what gets published and packed into the APK)
  index.html
  css/app.css
  js/indicators.js   indicator maths, checked against the technicalindicators library
  js/strategies.js   signals, combined score and backtester
  js/deriv.js        Deriv WebSocket client
  js/app.js          screens, scanner, alerts
  sw.js              offline cache for the web app
server/scan.js       the 24/7 scanner run by GitHub Actions
scripts/             prepare-web.sh draws the icons and copies the chart library into www/
test/engine.test.js  engine tests (npm test)
.github/workflows/   builds the APK and publishes the web app
```

## Connection

SynthScope connects to `wss://api.derivws.com/trading/v1/options/ws/public`, Deriv's public feed that needs no login. If that fails it falls back to the older `wss://ws.derivws.com/websockets/v3` server. You can pick the server and set your own App ID in Settings.

## How the builds work

Every push to `main` runs two GitHub Actions workflows:

1. **Publish web app** puts the `www` folder on GitHub Pages at `https://<your-username>.github.io/synthscope/`. Turn this on once in **Settings > Pages > Source: GitHub Actions**.
2. **Build Android APK** runs the tests, wraps `www` with Capacitor, builds the APK and attaches `SynthScope.apk` to a new release under **Releases**.

## Run it on a computer

```
npm install
npm run prepare-web
npm test
npx serve www
```

## Not financial advice

SynthScope shows indicator readings and measures how they performed in the past. Past results do not predict future ones. Practise on a Deriv demo account and never trade money you cannot afford to lose.

Charts by [TradingView Lightweight Charts](https://www.tradingview.com/) (Apache 2.0).
