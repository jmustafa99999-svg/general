import TelegramBot from "node-telegram-bot-api";
import { TradingViewAPI, Intervals } from 'tradingview-scraper'; 
import 'dotenv/config'; 

// ----------------------------------------------------------------------
//                        الإعدادات الأساسية
// ----------------------------------------------------------------------

const TOKEN = process.env.TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error("❌ تأكد من وضع TOKEN و CHAT_ID داخل قسم Secrets.");
  process.exit();
}
const bot = new TelegramBot(TOKEN, { polling: true });

// مخزن لحالة الأزبواج قيد المراقبة
const activeStreams = {}; 
const historicalData = {}; 

// قائمة الأزواج المسموح بها
const allowed = ["EURUSD","GBPUSD","USDJPY","AUDUSD","EURJPY","GBPJPY","USDCAD","NZDUSD"];
const MIN_VOLATILITY = 0.00005; // الحد الأدنى للتقلب (ATR)


// ----------------------------------------------------------------------
//                        دوال الحسابات الفنية
// ----------------------------------------------------------------------

function calculateEMA(closes, period) {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b) / period; 

    const emas = [ema];
    for (let i = period; i < closes.length; i++) {
        ema = closes[i] * k + emas[emas.length - 1] * (1 - k);
        emas.push(ema);
    }
    return emas.length > 0 ? emas[emas.length - 1] : null; 
}

function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    const relevantCloses = closes.slice(-(period + 1));
    
    for (let i = 1; i < relevantCloses.length; i++) {
        const diff = relevantCloses[i] - relevantCloses[i-1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    const rs = avgGain / (avgLoss === 0 ? 1 : avgLoss);
    return (100 - 100 / (1 + rs)).toFixed(2);
}

function calculateBollingerBands(closes, period = 20, numStdDev = 2) {
    if (closes.length < period) return null;

    const relevantCloses = closes.slice(-period);
    const sma = relevantCloses.reduce((a, b) => a + b) / period;

    const variance = relevantCloses.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    const upperBand = sma + (stdDev * numStdDev);
    const lowerBand = sma - (stdDev * numStdDev);

    return { sma, upperBand, lowerBand };
}

function calculateMACD(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (closes.length < slowPeriod) return null;

    const currentMACD = calculateEMA(closes, fastPeriod) - calculateEMA(closes, slowPeriod);
    const prevMACD = calculateEMA(closes.slice(0, -1), fastPeriod) - calculateEMA(closes.slice(0, -1), slowPeriod);

    let cross = "None";
    if (currentMACD > 0 && prevMACD < 0) {
        cross = "Bullish";
    }
    if (currentMACD < 0 && prevMACD > 0) {
        cross = "Bearish";
    }
    
    return { macd: currentMACD, cross }; 
}

function calculateATR(ohlcData, period = 14) {
    if (ohlcData.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < ohlcData.length; i++) {
        const current = ohlcData[i];
        const previousClose = ohlcData[i - 1].close;

        const highMinusLow = current.high - current.low;
        const highMinusPreviousClose = Math.abs(current.high - previousClose);
        const lowMinusPreviousClose = Math.abs(current.low - previousClose);

        trueRanges.push(Math.max(highMinusLow, highMinusPreviousClose, lowMinusPreviousClose));
    }
    
    if (trueRanges.length < period) return null;
    const sumTR = trueRanges.slice(-period).reduce((a, b) => a + b, 0);
    return sumTR / period;
}

function calculateSLTP(price, atr, signalType) {
    const tpMultiplier = 1.5;
    const slMultiplier = 1.0;

    const takeProfitAmount = atr * tpMultiplier;
    const stopLossAmount = atr * slMultiplier;

    if (signalType === 'CALL') {const tp = price + takeProfitAmount;
        const sl = price - stopLossAmount;
        return { tp, sl };
    } else if (signalType === 'PUT') {
        const tp = price - takeProfitAmount;
        const sl = price + stopLossAmount;
        return { tp, sl };
    }
    return { tp: null, sl: null };
}

function checkHTFTrend(ohlcData5m) {
    if (!ohlcData5m || ohlcData5m.length < 50) return 'NEUTRAL'; 

    const closes5m = ohlcData5m.map(d => d.close);
    const ema50 = calculateEMA(closes5m, 50); 
    const currentPrice5m = closes5m[closes5m.length - 1];

    if (ema50 === null) return 'NEUTRAL';

    if (currentPrice5m > ema50) {
        return 'BULLISH'; // صاعد (فوق EMA50)
    } else if (currentPrice5m < ema50) {
        return 'BEARISH'; // هابط (تحت EMA50)
    } else {
        return 'NEUTRAL'; // محايد
    }
}


// ----------------------------------------------------------------------
//                     منطق الإشارة والتحكم (MAIN LOGIC)
// ----------------------------------------------------------------------

function generateAndSendSignal(pair, chatId) {
    
    const ohlcData1m = historicalData[pair]['1m'];
    const ohlcData5m = historicalData[pair]['5m'];
    
    if (!ohlcData1m  !ohlcData5m  ohlcData1m.length < 50 || ohlcData5m.length < 50) return; 

    // 1. حساب المؤشرات الفنية (1m)
    const closes1m = ohlcData1m.map(d => d.close);
    const price = closes1m[closes1m.length - 1];
    
    const bb = calculateBollingerBands(closes1m, 20, 2); 
    const rsi = calculateRSI(closes1m, 14);
    const macd = calculateMACD(closes1m);
    const atr = calculateATR(ohlcData1m, 14);
    
    if (atr === null  !bb  rsi === null || !macd) return; 

    const { upperBand, lowerBand } = bb;
    const rsiValue = parseFloat(rsi);
    
    // 2. فلترة التقلب (ATR Check)
    if (atr < MIN_VOLATILITY) {
        return; 
    }

    // 3. فلترة الاتجاه الأكبر (HTF Filter)
    const trend5m = checkHTFTrend(ohlcData5m);
    
    let signal = "⚪ محايد";
    let signalType = null;
    let strength = "";
    
    // 🟢 الشراء القوي (CALL) - 4 تأكيدات
    if (price <= lowerBand && rsiValue < 30 && macd.cross === "Bullish" && trend5m === 'BULLISH') {
      signal = "🟢 CALL (شراء قوي)";
      signalType = 'CALL';
      strength = " (قوة الإشارة: عالية جدًا)";
    }
    
    // 🔴 البيع القوي (PUT) - 4 تأكيدات
    if (price >= upperBand && rsiValue > 70 && macd.cross === "Bearish" && trend5m === 'BEARISH') {
      signal = "🔴 PUT (بيع قوي)";
      signalType = 'PUT';
      strength = " (قوة الإشارة: عالية جدًا)";
    }
    
    if (signalType === null) return; 

    // 4. تطبيق إدارة المخاطر (SL/TP)
    const { tp, sl } = calculateSLTP(price, atr, signalType);

    // 5. إرسال الرسالة النهائية
    const expiryRecommendation = "🕰️ مدة الصفقة: *3 - 5 دقائق*";
    const riskLevels = 🛑 SL: ${sl.toFixed(5)} | 🏆 TP: ${tp.toFixed(5)};

    const message = `
📊 *${pair}* (1m/5m) - استراتيجية التأكيد الرباعي
السعر الحالي: ${price.toFixed(5)}

RSI (14): ${rsi} | ATR (14): ${atr.toFixed(5)}
الاتجاه الأكبر (5m): ${trend5m === 'BULLISH' ? 'صاعد' : 'هابط'}

${riskLevels}
${expiryRecommendation}

📌 الإشارة: ${signal}${strength}
`;
    bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
}

async function getHistoryAndStream(pair, chatId) {
    
    if (activeStreams[pair]) {
        bot.sendMessage(chatId, ⚠️ ${pair} قيد المراقبة بالفعل., { parse_mode: "Markdown" });
        return;
    }

    try {
        const tv = new TradingViewAPI();
        
        // 1. جلب البيانات التاريخية لـ 1m و 5m
        const history1m = await tv.getMarketHistory({ symbol: FX_IDC:${pair}, interval: Intervals.i1m, barCount: 100 });
        const history5m = await tv.getMarketHistory({ symbol: FX_IDC:${pair}, interval: Intervals.i5m, barCount: 50 });
        
        if (!history1m  !history5m  history1m.length < 50 || history5m.length < 50) { 
            bot.sendMessage(chatId, ❌ لم يتم العثور على بيانات كافية لـ *${pair}*., { parse_mode: "Markdown" });
            return;
        }

        historicalData[pair] = {'1m': history1m.map(h => ({ open: h.open, high: h.high, low: h.low, close: h.close })),
            '5m': history5m.map(h => ({ open: h.open, high: h.high, low: h.low, close: h.close }))
        };
        
        // 2. بدء البث المزدوج (1m للإشارات)
        const stream1m = await tv.getMarketStream({ symbol: FX_IDC:${pair}, interval: Intervals.i1m });
        stream1m.on(Intervals.i1m, (data) => {
            if (data.status === 'ok') {
                const newBar = data.bar;
                historicalData[pair]['1m'].shift();
                historicalData[pair]['1m'].push({ open: newBar.open, high: newBar.high, low: newBar.low, close: newBar.close }); 
                generateAndSendSignal(pair, chatId);
            }
        });
        
        // 3. بدء البث المزدوج (5m للاتجاه)
        const stream5m = await tv.getMarketStream({ symbol: FX_IDC:${pair}, interval: Intervals.i5m });
        stream5m.on(Intervals.i5m, (data) => {
            if (data.status === 'ok') {
                const newBar = data.bar;
                historicalData[pair]['5m'].shift();
                historicalData[pair]['5m'].push({ open: newBar.open, high: newBar.high, low: newBar.low, close: newBar.close }); 
            }
        });

        activeStreams[pair] = { stream1m, stream5m }; 
        bot.sendMessage(chatId, ✅ تم بدء المراقبة الفورية (1m و 5m) لـ *${pair}*!, { parse_mode: "Markdown" });
        
    } catch (e) {
        console.error(`خطأ في بدء البث لـ ${pair}:`, e);
        bot.sendMessage(chatId, ❌ خطأ في الاتصال بمصدر البيانات لـ *${pair}*., { parse_mode: "Markdown" });
    }
}


// 🚨 وظيفة معالجة الأوامر (Start/Stop/Status)
bot.on("message", async msg => {
  const text = msg.text.trim();
  const chatId = msg.chat.id;
  const parts = text.split(/\s+/); 

  const command = parts[0];
  const pair = parts.length > 1 ? parts[1].toUpperCase() : null; 

  
  // 1. معالجة أمر الحالة /status
  if (command === '/status') {
    const activePairs = Object.keys(activeStreams);
    if (activePairs.length === 0) {
        bot.sendMessage(chatId, "⚪ لا يوجد أي زوج قيد المراقبة حاليًا.", { parse_mode: "Markdown" });
    } else {
        const list = activePairs.join('\n* ');
        bot.sendMessage(chatId, 🟢 الأزواج قيد المراقبة الفورية:\n\n* ${list}, { parse_mode: "Markdown" });
    }
    return;
  }

  // 2. معالجة أمر الإيقاف /stop
  if (command === '/stop') {
    if (!pair || !allowed.includes(pair)) {
        bot.sendMessage(chatId, "❌ صيغة الأمر خاطئة. استخدم: /stop EURUSD");
        return;
    }
    
    if (activeStreams[pair]) {
        activeStreams[pair].stream1m.stop(); 
        activeStreams[pair].stream5m.stop(); 
        delete activeStreams[pair];
        delete historicalData[pair];
        bot.sendMessage(chatId, ⏹️ تم إيقاف المراقبة الفورية لـ *${pair}* بنجاح., { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, ⚠️ الزوج *${pair}* ليس قيد المراقبة أصلاً., { parse_mode: "Markdown" });
    }
    return;
  }
  
  // 3. معالجة أمر البداية /start أو اسم الزوج مباشرة
  if (command === '/start'  allowed.includes(pair)  allowed.includes(text.toUpperCase())) {
      const targetPair = pair || (allowed.includes(text.toUpperCase()) ? text.toUpperCase() : null);

      if (!targetPair || !allowed.includes(targetPair)) {
          bot.sendMessage(chatId, "❌ أمر غير معروف. الأوامر المتاحة: /start, /stop, /status", { parse_mode: "Markdown" });
          return;
      }
      
      await getHistoryAndStream(targetPair, chatId);
      return;
  }

  bot.sendMessage(chatId, "❌ أمر غير صالح. الأوامر المتاحة هي:\n* /start [الزوج]\n* /stop [الزوج]\n* /status", { parse_mode: "Markdown" });
});

console.log("🤖 البوت يعمل الآن!");
