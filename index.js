const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();
const { URLSearchParams } = require('url');

// =================== KONFIGURASI BOT ===================
// Semua konfigurasi sekarang dimuat dari file .env
const CONFIG = {
    // Target
    TARGET_BALANCE_ID: process.env.TARGET_BALANCE_ID,
    UNLOCK_TIME_ISO: process.env.UNLOCK_TIME_ISO,
    AMOUNT_TO_CLAIM: process.env.AMOUNT_TO_CLAIM,
    // Kunci & Alamat
    SPONSOR_MNEMONIC: process.env.SPONSOR_MNEMONIC,
    TARGET_MNEMONIC: process.env.TARGET_MNEMONIC,
    RECEIVER_ADDRESS: process.env.RECEIVER_ADDRESS,
    // Pengaturan Serangan
    FEE_PER_TRANSACTION: process.env.FEE_PER_TRANSACTION || "2",
    SNIPER_LEAD_TIME_ADJUSTMENT_MS: parseInt(process.env.SNIPER_LEAD_TIME_ADJUSTMENT_MS || "-20", 10),
    SNIPER_REQUESTS_PER_ENDPOINT: parseInt(process.env.SNIPER_REQUESTS_PER_ENDPOINT || "15", 10),
    MEMO: process.env.MEMO || "ManualSniper",
    // Endpoint API Pi yang akan diserang secara simultan
    SNIPER_API_ENDPOINTS: [
        'https://mainnet.zendshost.id',
        'https://apimainnet.vercel.app',
    ],
};
// ========================================================

const PI_NETWORK_PASSPHRASE = 'Pi Network';

// --- FUNGSI UTILITAS LENGKAP ---

async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId, text: message, parse_mode: 'HTML', disable_web_page_preview: true
        });
    } catch (e) { console.error("Telegram error:", e.message); }
}

async function getKeypairFromMnemonic(mnemonic, name) {
    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        throw new Error(`Mnemonic untuk "${name}" tidak valid atau tidak ditemukan di file .env.`);
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

async function checkLatency(endpoint) {
    const startTime = Date.now();
    try {
        await axios.get(`${endpoint}/ledgers?limit=1&order=desc`, { timeout: 2000 });
        const latency = Date.now() - startTime;
        console.log(`   - Latensi ke ${endpoint}: ${latency}ms`);
        return latency;
    } catch (e) {
        console.warn(`   - Gagal mengukur latensi ke ${endpoint}.`);
        return Infinity;
    }
}

async function submitTransaction(xdr, endpoint) {
    try {
        const response = await axios.post(`${endpoint}/transactions`, new URLSearchParams({ tx: xdr }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 5000
        });
        if (response.data.status === 'ERROR' || response.data.status === 'DUPLICATE') {
            throw new Error(`[${response.data.status}]`);
        }
        return { hash: response.data.hash, endpoint };
    } catch (e) {
        throw new Error(`Gagal submit ke ${endpoint}: ${e.message}`);
    }
}

// --- FUNGSI UTAMA SNIPER MANUAL ---
async function main() {
    console.log("🚀 Bot Sniper Manual Dimulai (Mode .env)...");
    
    // Validasi input dari .env
    const requiredVars = ['TARGET_BALANCE_ID', 'UNLOCK_TIME_ISO', 'AMOUNT_TO_CLAIM', 'SPONSOR_MNEMONIC', 'TARGET_MNEMONIC', 'RECEIVER_ADDRESS'];
    for (const v of requiredVars) {
        if (!CONFIG[v]) throw new Error(`Variabel wajib "${v}" tidak ditemukan di file .env.`);
    }
    if (!CONFIG.RECEIVER_ADDRESS.startsWith('M')) {
        throw new Error("RECEIVER_ADDRESS harus berupa Muxed Address (diawali 'M').");
    }

    try {
        // LANGKAH 1: PERSIAPKAN SEMUA KUNCI
        console.log("🔑 Mempersiapkan kunci dari .env...");
        const sponsorKeypair = await getKeypairFromMnemonic(CONFIG.SPONSOR_MNEMONIC, "Sponsor");
        const targetKeypair = await getKeypairFromMnemonic(CONFIG.TARGET_MNEMONIC, "Target");

        // LANGKAH 2: UKUR LATENSI & HITUNG WAKTU TEMBAK
        console.log("\n📡 Mengukur latensi jaringan...");
        const primaryEndpoint = CONFIG.SNIPER_API_ENDPOINTS[0];
        const avgLatency = await checkLatency(primaryEndpoint);
        if (avgLatency === Infinity) throw new Error(`Endpoint utama ${primaryEndpoint} tidak terjangkau.`);

        const unlockTimestamp = new Date(CONFIG.UNLOCK_TIME_ISO).getTime();
        const dynamicLeadTime = avgLatency + (CONFIG.SNIPER_LEAD_TIME_ADJUSTMENT_MS * -1);
        const targetTimestamp = unlockTimestamp - dynamicLeadTime;
        
        console.log("\n--- STRATEGI SERANGAN ---");
        console.log(`🎯 Target Balance ID : ${CONFIG.TARGET_BALANCE_ID}`);
        console.log(`⏰ Waktu Buka Kunci : ${CONFIG.UNLOCK_TIME_ISO}`);
        console.log(`💰 Jumlah Klaim      : ${CONFIG.AMOUNT_TO_CLAIM} π`);
        console.log(`💥 Waktu Tembak (UTC): ${new Date(targetTimestamp).toISOString()}`);
        console.log(` Fee: ${CONFIG.FEE_PER_TRANSACTION} stroops | Req/EP: ${CONFIG.SNIPER_REQUESTS_PER_ENDPOINT}`);
        console.log("--------------------------\n");
        await sendTelegramNotification(`🎯 <b>Sniper Manual Siap!</b>\nTarget: <code>${CONFIG.TARGET_BALANCE_ID}</code>\nJumlah: <code>${CONFIG.AMOUNT_TO_CLAIM} π</code>\nWaktu Tembak: <code>${new Date(targetTimestamp).toISOString()}</code>`);

        // LANGKAH 3: PRE-BUILD & PRE-SIGN TRANSAKSI
        console.log("🛠️ Membangun dan menandatangani transaksi...");
        const server = new StellarSdk.Server(primaryEndpoint);
        const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
        
        const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
            fee: CONFIG.FEE_PER_TRANSACTION,
            networkPassphrase: PI_NETWORK_PASSPHRASE,
            allowMuxedAccounts: true,
        })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({
            balanceId: CONFIG.TARGET_BALANCE_ID,
            source: targetKeypair.publicKey(),
        }))
        .addOperation(StellarSdk.Operation.payment({
            destination: CONFIG.RECEIVER_ADDRESS,
            asset: StellarSdk.Asset.native(),
            amount: CONFIG.AMOUNT_TO_CLAIM,
            source: targetKeypair.publicKey(),
        }))
        .addMemo(StellarSdk.Memo.text(CONFIG.MEMO))
        .setTimeout(60).build();

        transaction.sign(targetKeypair);
        transaction.sign(sponsorKeypair);
        const signedXdr = transaction.toXDR();
        console.log("✅ Transaksi siap. Menunggu waktu tembak...");

        // LANGKAH 4: HITUNG MUNDUR & LOOP TUNGGU-SIBUK
        while (Date.now() < targetTimestamp - 10000) {
            console.log(`   ⏳ Menunggu... Sisa waktu: ${Math.round((targetTimestamp - Date.now()) / 1000)}s`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        while (Date.now() < targetTimestamp - 100) {
            process.stdout.write(`   🔥 Countdown: ${(targetTimestamp - Date.now()).toString().padStart(4, ' ')}ms   \r`);
        }
        while (Date.now() < targetTimestamp) { /* Busy-wait loop */ }

        // LANGKAH 5: SERANGAN SATURASI!
        console.log("\n\n💥💥💥 TEMBAK! TEMBAK! TEMBAK! 💥💥💥");
        const totalRequests = CONFIG.SNIPER_API_ENDPOINTS.length * CONFIG.SNIPER_REQUESTS_PER_ENDPOINT;
        console.log(`   -> Mengirim ${totalRequests} permintaan secara serentak...`);
        const submissionPromises = [];
        CONFIG.SNIPER_API_ENDPOINTS.forEach(endpoint => {
            for (let i = 0; i < CONFIG.SNIPER_REQUESTS_PER_ENDPOINT; i++) {
                submissionPromises.push(submitTransaction(signedXdr, endpoint));
            }
        });

        // LANGKAH 6: PROSES HASIL
        const results = await Promise.allSettled(submissionPromises);
        let successResult = results.find(r => r.status === 'fulfilled');

        if (successResult) {
            const successMessage = `🏆 <b>SNIPE BERHASIL!</b> 🏆\n\n<b>Hash:</b> <code>${successResult.value.hash}</code>\n🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${successResult.value.hash}">Lihat di Explorer</a>`;
            await sendTelegramNotification(successMessage);
        } else {
            await sendTelegramNotification(`😭 <b>SNIPE GAGAL</b> 😭\nSemua ${totalRequests} permintaan gagal. Kemungkinan kalah cepat.`);
        }

    } catch (error) {
        console.error("\n🚨 KESALAHAN FATAL:", error.message);
        await sendTelegramNotification(`🚨 <b>BOT ERROR</b>: ${error.message}`);
        process.exit(1);
    }
}

main();
