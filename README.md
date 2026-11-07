# SynthScope

Smart Scan, live trade plans and backtests for Deriv's synthetic indices (Vixed Indices), as a web app you can install on Android and as an APK.

SynthScope reads Deriv's public price feed. It never logs in to your Deriv account and never places trades.

## What it does

SynthScope calls Deriv's synthetic indices **Vixed Indices**.

- **Smart Scan** backtests all 13 regular strategies (or the 6 scalper ones) on every Vixed index and every timeframe you pick (1 minute to 1 day). It finds the strategy that has worked best on each one and shows its live signals as cards with entry, stop loss, TP1, TP2, dollar risk and MT5 lot size. With live mode on, it rescans after every candle closes.
- **Chart** shows live candles, the selected strategy's signals and the active trade plan as lines. "Best here" ranks the top 3 strategies for that market right now, and it can check all 12 timeframes at once.
- **Strategies** holds the library and a backtester that trades each strategy with the app's own stops and targets.
- **Alerts** watch up to 20 market and timeframe pairs, alert with sound, vibration and a notification, and forward test every alert until it hits the stop, TP1 or the max hold.
- **Scalper mode** (switch at the top of Smart Scan and the Chart) runs a separate library of 1 minute setups with tighter stops, TP1 at 1R and a 15 candle limit.
- **Under $10** finds trades that fit a small balance on MT5 or Deriv Trader Multipliers, with a Safe plan (2%) and a Challenge plan (5% ladder), and simulates each strategy's odds of reaching the goal.
- **Daily guardrails** pause signals after a daily loss, a number of trades, or a profit target. They count the trades you mark with Took it.

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

### Scalper library (1 minute)

| # | Strategy | Rules | Source |
|---|---|---|---|
| 1 | EMA 9/21 + RSI 7 Scalp | EMA 9 crosses EMA 21 with price on the right side of the 50 EMA and RSI 7 past 50 | Common V75 and DTrader scalping guides |
| 2 | RSI 2 Snapback (Connors) | Above the 200 EMA and RSI 2 under 10 (mirror for sells), exit when price closes back across the 5 EMA | Larry Connors' RSI 2 system |
| 3 | Bollinger 20/2 + RSI 4 Reversal | RSI 4 back above 20 after a lower band touch (mirror at 80), exit at the middle band | FXOpen 1 minute scalping strategies |
| 4 | Keltner Breakout + RSI 50 | Two closes outside EMA 20 +/- 2 ATR with RSI 14 past 50, exit back through the 20 EMA | FXOpen 1 minute scalping strategies |
| 5 | Stochastic 5/3/3 Pullback | Rising 50 EMA and %K crossing %D up from below 20 (mirror from 80) | Fast stochastic scalping settings |
| 6 | Spike Scalp (EMA 200 + RSI 14) | RSI dip under 30 above the 200 EMA with a red candle (mirror for Crash), out on the first spike | Deriv community Boom and Crash scalping post |

Scalper plans: stop from the swing of the last 5 candles when it sits 0.5 to 2 ATR away, otherwise 1 ATR; TP1 1R, TP2 2R; 15 candle limit.

### Win rate and costs

Every backtest pays the market's spread, and the chance level it is compared with pays it too. Each result shows the win rate next to the win rate it needs to break even with its own average win and loss. Strategies are ranked by profit after costs, not by win rate, because a close target and a far stop can win most trades and still lose money.

Spreads, minimum lots and contract sizes are estimates (minimum lots from published Deriv MT5 tables, October 2026). Correct any of them in **Settings > Costs and lot sizes** with the numbers from MT5's Specification window.

On Boom only buys are taken and on Crash only sells, because that is the spike direction. This can be turned off in Settings.

## Trade plans

- **Entry:** the live price when the signal fires on a closed candle.
- **Stop loss (smart mix):** just beyond the nearest swing low or high of the last 10 candles when that sits 0.8 to 3 ATR away, otherwise 1.5 ATR.
- **Take profit:** TP1 at 1.5 times the risk, TP2 at 3 times.
- **Size:** risk is a percent of the balance you enter (2% by default). MT5 lots = risk / (stop distance x contract size). If that is below the market's minimum lot, the card says how much the smallest trade would really risk.

## How strategies are scored

Every backtest trade uses the plan above and exits at the stop, TP1, or the max hold. Results are compared with a coin-flip trader using the same stops and targets on the same market, which catches the Boom/Crash trap where a high win rate still loses money.

The **edge score** (0 to 100) comes from the z score of that edge, corrected for picking the best of the strategies tested (13 regular or 6 scalper), because testing many and keeping the winner makes luck look like skill. 65+ is promising, and 85+ needs a corrected z of 3 with a positive edge in both halves of the history. Fewer than 20 trades scores 0. On random price series about 3 to 5 in 100 markets reach 65 and about 1 in 100 reach 85. A planted real trend scores 100 in both modes.

## Under $10

- **MT5:** a trade must be at least the market's minimum lot. The tab shows how much the smallest trade risks on each market at a typical stop, and only offers markets where that fits your plan.
- **Multipliers:** stakes start at $1 and the loss is capped at the stake. Deriv charges a commission of about 0.036% of stake x multiplier (0.02% on Boom and Crash), at least $0.10 a trade, so on a $0.20 risk the fee alone is half a loss. The backtests include it.
- **Safe plan:** 2% per trade, goal is doubling the balance. **Challenge plan:** 5% of the ladder step you have reached ($5, $7.50, $10, $15, $20, $30, $40, $50), goal set by you.
- The simulation replays each strategy's backtest trades 1,500 times from your balance (with the luck of picking the winner taken out) and reports how often the account reaches the goal or can no longer place a trade.

## 24/7 scanner and phone alerts (GitHub Actions + ntfy)

`server/scan.js` runs on GitHub's servers every 5 minutes, even when your phone is off. Each run loads every Vixed index on 5m, 15m, 30m and 1h, ranks all 13 regular strategies with the same engine as the app (spread included), and sends a push alert through the free [ntfy](https://ntfy.sh) app for each fresh signal whose edge score is 70 or more. Every alert shows the entry, stop loss, TP1, TP2, dollar risk and MT5 lots. The scanner then follows each alert and sends a result message when it hits the stop or TP1, with your running forward record.

GitHub runs scheduled jobs every 5 to 15 minutes, so 1 to 3 minute timeframes and Scalper mode stay in the app only. Always check the live price before you enter.

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
  js/strategies.js   regular and scalper strategies, backtester, costs, sizing, account simulator
  js/deriv.js        Deriv WebSocket client
  js/app.js          screens, Smart Scan, Under $10, guardrails, alerts
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
