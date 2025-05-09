import fs from 'fs/promises'
import ccxt from 'ccxt'
import fetch from 'node-fetch'

/** CONFIG — set via GH secrets or workflow env */
const BOT_TOKEN       = process.env.BOT_TOKEN
const CHAT_ID         = process.env.CHAT_ID
const ATR_LENGTH      = +process.env.ATR_LENGTH    || 14
const RISK_MULTIPLIER = +process.env.RISK_MULTIPLIER|| 1.5
const TP_PERCENT      = +process.env.TP_PERCENT     || 0.5
const SL_PERCENT      = +process.env.SL_PERCENT     || 1.0
const NUM_TP          = 5  // fixed

const exchange = new ccxt.kucoin()

async function loadState(){
  try {
    return JSON.parse(await fs.readFile('state.json','utf8'))
  } catch {
    return { inPosition:false, direction:null, entryPrice:null, tpsHit:[] }
  }
}

async function saveState(state){
  await fs.writeFile('state.json', JSON.stringify(state, null,2))
}

async function sendTelegram(msg){
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ chat_id: CHAT_ID, text: msg })
  })
}

// compute ATR from OHLCV array
function computeATR(ohlcv, length){
  const tr = []
  for(let i=1; i<ohlcv.length; i++){
    let [t,o,h,l,c] = ohlcv[i]
    let prevC = ohlcv[i-1][4]
    tr.push(Math.max(h-l, Math.abs(h-prevC), Math.abs(l-prevC)))
  }
  // simple SMA of TR
  return tr.slice(-length).reduce((s,v)=>s+v,0)/length
}

(async()=>{
  const state = await loadState()

  // 1) fetch last 100 bars
  const ohlc = await exchange.fetchOHLCV('BTC/USDT','1m', undefined, 100)
  const atr = computeATR(ohlc, ATR_LENGTH) * RISK_MULTIPLIER

  // 2) build your stop-ATR “dir” series
  const stops = [], dirs = []
  for(let i=1; i<ohlc.length; i++){
    let [,o,h,l,c] = ohlc[i]
    let [, , , , prevC] = ohlc[i-1]
    let hl2 = (h + l)/2
    // init
    if(i===1){
      stops[i] = hl2
      dirs[i] = 0
      continue
    }
    const prevStop = stops[i-1]
    const longStop  = hl2 - atr
    const shortStop = hl2 + atr

    let dir = dirs[i-1]
    if(dir === -1 && c > shortStop) dir = 1
    else if(dir === 1 && c < longStop) dir = -1
    stops[i] = dir===1 ? longStop : shortStop
    dirs[i] = dir
  }

  const lastIdx = ohlc.length-1
  const dirNow = dirs[lastIdx]
  const prevDir= dirs[lastIdx-1]
  const [ , , , , close ] = ohlc[lastIdx]
  const entryPrice = state.entryPrice

  // 3) ENTRY
  if(!state.inPosition && dirNow===1 && prevDir===-1){
    state.inPosition = true
    state.direction = 1
    state.entryPrice = close
    state.tpsHit = []
    await sendTelegram(`🚀 LONG ENTRY @ ${close.toFixed(4)}`)
  } else if(!state.inPosition && dirNow===-1 && prevDir===1){
    state.inPosition = true
    state.direction = -1
    state.entryPrice = close
    state.tpsHit = []
    await sendTelegram(`🐻 SHORT ENTRY @ ${close.toFixed(4)}`)
  }

  // 4) MANAGE OPEN POSITION
  if(state.inPosition){
    const high = ohlc[lastIdx][2]
    const low  = ohlc[lastIdx][3]
    const ep   = state.entryPrice
    // compute SL & TP levels
    const SL = state.direction===1
      ? ep * (1 - SL_PERCENT/100)
      : ep * (1 + SL_PERCENT/100)

    for(let lvl=1; lvl<=NUM_TP; lvl++){
      if(state.tpsHit.includes(lvl)) continue
      const tpPrice = state.direction===1
        ? ep * (1 + TP_PERCENT/100 * lvl)
        : ep * (1 - TP_PERCENT/100 * lvl)
      // check hit
      if((state.direction===1 && high>=tpPrice) ||
         (state.direction===-1&& low <=tpPrice)){
        state.tpsHit.push(lvl)
        await sendTelegram(`✅ TP${lvl} HIT @ ${tpPrice.toFixed(4)}`)
      }
    }
    // SL hit?
    if((state.direction===1 && low<=SL) ||
       (state.direction===-1&& high>=SL)){
      state.inPosition = false
      state.direction = null
      await sendTelegram(`💀 SL HIT @ ${SL.toFixed(4)} — EXIT`)
    }
    // Opposite signal exit?
    if(state.inPosition && ((state.direction===1 && dirNow===-1) ||
                            (state.direction===-1&& dirNow===1))){
      state.inPosition = false
      const side = state.direction===1? 'LONG':'SHORT'
      state.direction = null
      await sendTelegram(`↔️ ${side} EXIT @ ${close.toFixed(4)} (Opposite Signal)`)
    }
  }

  // 5) save & commit state.json
  await saveState(state)
})().catch(err=>{
  console.error(err)
  process.exit(1)
})
