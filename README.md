# SynthScope

Signals and backtests for Deriv synthetic indices, as a web app you can install on Android and as an APK.

SynthScope reads Deriv's public price feed. It never logs in to your Deriv account and never places trades.

## What it does

- **Scan** ranks every synthetic market (Volatility, Boom/Crash, Step, Jump and the rest) by a combined signal on any of Deriv's 12 timeframes, from 1 minute to 1 day.
- **Chart** shows live candles with EMA 21, EMA 200 and Supertrend, arrows where the combined signal fired, a breakdown of all seven indicators, and a check across all 12 timeframes at once.
- **Backtest** tests each indicator on up to 5,000 candles of real Deriv history, for one market or all of them, and compares the result with chance.
- **Alerts** watch up to 20 market and timeframe pairs and alert you with sound, vibration and a notification when a new BUY or SELL appears on a closed candle. Alerts only run while the app is open.

## The indicators

| Tool | Type | Signal |
|---|---|---|
| EMA 9/21 cross | Trend | Fast EMA crosses the slow EMA |
| EMA 50/200 trend | Trend | Price and EMA 50 on one side of EMA 200 |
| Supertrend 10/3 | Trend | Price flips across the ATR trailing line |
| MACD 12/26/9 | Trend | MACD crosses its signal line |
| RSI 14 reversal | Oscillator | RSI back above 30 or below 70 |
| Bollinger 20/2 bounce | Oscillator | Close back inside a band |
| Stochastic 14/3/3 | Oscillator | %K/%D cross below 20 or above 80 |

The **combined score** (-100 to +100) is a weighted vote of all seven. When ADX is 25 or more the trend tools count three times as much as the oscillators; below 20 it is the other way round. BUY or SELL appears when the score passes the threshold you set in Settings (50 by default).

## Reading the backtest honestly

Deriv generates these markets with a random number generator, so no indicator is proven to work on them. The backtest is built to stop you fooling yourself:

- **Chance** is the win rate a random entry in the same direction would get on that market. On Boom and Crash it is far from 50% because price drifts between spikes.
- **Avg move** is the average result per trade in ATR units. A strategy that wins 97% of the time can still lose money on Boom/Crash. The app flags this as **Wins often, loses big**.
- **z** measures how unlikely the edge is by luck. **Possible edge** needs z of 3 or more, a positive average move, and a positive edge in both halves of the history.
- When you test many pairs, the app tells you how many would pass by pure luck.

Trades in the backtest never overlap, enter at the close of the signal candle, and exit after the hold time you choose.

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
