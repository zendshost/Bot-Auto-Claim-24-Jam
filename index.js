const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();
const { URLSearchParams } = require('url');

// ================= KONFIGURASI BOT EDISI KOMPETISI =================
const CONFIG = {
    // (PENTING!) Mnemonic phrase dari akun SPONSOR. HARUS diisi di file .env
    SPONSOR_MNEMONIC: process.env.SPONSOR_MNEMONIC,

    // (PENTING!) ID dari Saldo yang akan Anda klaim.
    TARGET_BALANCE_ID: "0000000020189228eaa86317f1e7f4cad306df9654dfc84c5187afec209e8d99f92a79bf",

    // Endpoint API Pi yang akan diserang secara simultan untuk meningkatkan peluang.
    API_ENDPOINTS: [
        'https://api.mainnet.minepi.com',
        'https://mainnet.zendshost.id',
        // Anda bisa menambahkan node publik lain jika menemukannya di masa depan
    ],

    // Berapa banyak permintaan yang akan dikirim ke SETIAP endpoint secara bersamaan.
    REQUESTS_PER_ENDPOINT: 8,

    // Penyesuaian waktu manual (dalam milidetik).
    // Nilai negatif akan membuat bot menembak LEBIH AWAL dari waktu unlock dikurangi ping.
    // Contoh: -20 berarti menembak 20ms lebih cepat. Ini untuk mengantisipasi variasi jaringan.
    // Mulai dengan -10 hingga -30.
    MANUAL_LEAD_TIME_ADJUSTMENT_MS: -20,
};
// ====================================================================

const PI_NETWORK_PASSPHRASE = 'Pi Network';

// Fungsi untuk mengirim notifikasi ke Telegram
async function sendTelegramNotification(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
    } catch (e) {
        console.error("Telegram error:", e.message);
    }
}

// Fungsi untuk mendapatkan Keypair dari Mnemonic
async function getKeypairFromMnemonic(mnemonic) {
    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        throw new Error("Mnemonic tidak valid atau tidak ditemukan. Mohon cek file .env untuk SPONSOR_MNEMONIC.");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

// Fungsi untuk mengukur latensi (ping) ke sebuah endpoint
async function checkLatency(endpoint) {
    const PING_COUNT = 5;
    let totalLatency = 0;
    console.log(`📡 Mengukur latensi ke ${endpoint}...`);
    for (let i = 0; i < PING_COUNT; i++) {
        const startTime = Date.now();
        try {
            await axios.get(`${endpoint}/ledgers?limit=1&order=desc`, { timeout: 2000 });
            const latency = Date.now() - startTime;
            totalLatency += latency;
            console.log(`   - Ping #${i + 1}: ${latency}ms`);
        } catch (e) {
            console.warn(`   - Ping #${i + 1} gagal ke ${endpoint}. Mungkin sedang down atau timeout.`);
            return Infinity; // Kembalikan nilai besar jika endpoint tidak merespons
        }
    }
    const avgLatency = Math.round(totalLatency / PING_COUNT);
    console.log(`   - ✅ Rata-rata latensi: ${avgLatency}ms`);
    return avgLatency;
}

// Fungsi untuk mengirimkan transaksi ke endpoint tertentu
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

// Fungsi untuk mengambil detail claimable balance dari server
async function fetchClaimDetails(balanceId, apiServer) {
    console.log(`\n🔍 Mengambil detail untuk Balance ID dari ${apiServer}...`);
    const url = `${apiServer}/claimable_balances/${balanceId}`;
    try {
        const response = await axios.get(url);
        const data = response.data;
        let unlockTime = null;
        for (const claimant of data.claimants) {
            if (claimant.predicate?.not?.abs_before) {
                unlockTime = claimant.predicate.not.abs_before;
                break;
            }
        }
        if (!unlockTime) throw new Error("Tidak dapat menemukan kondisi waktu (predicate 'not.abs_before') pada data claimable balance.");
        console.log("   - Detail berhasil didapatkan.");
        return { unlockTime, sponsor: data.sponsor };
    } catch(error) {
        throw new Error(`Gagal mengambil detail dari API: ${error.message}`);
    }
}

// Fungsi utama bot
async function main() {
    console.log("🚀 Bot Sniper Edisi Kompetisi Dimulai!");
    try {
        // LANGKAH 1: UKUR LATENSI KE ENDPOINT UTAMA
        const primaryEndpoint = CONFIG.API_ENDPOINTS[0];
        const avgLatency = await checkLatency(primaryEndpoint);
        if (avgLatency === Infinity) {
            throw new Error(`Endpoint utama ${primaryEndpoint} tidak dapat dijangkau. Bot berhenti.`);
        }
        if (avgLatency > 100) {
            console.warn("⚠️ PERINGATAN: Latensi Anda > 100ms. Peluang menang lebih kecil. Sangat disarankan untuk menggunakan VPS yang lebih dekat dengan server API.");
        }

        // LANGKAH 2: AMBIL DETAIL & HITUNG WAKTU TEMBAK
        const { unlockTime, sponsor } = await fetchClaimDetails(CONFIG.TARGET_BALANCE_ID, primaryEndpoint);
        const unlockTimestamp = new Date(unlockTime).getTime();
        
        const dynamicLeadTime = avgLatency + (CONFIG.MANUAL_LEAD_TIME_ADJUSTMENT_MS * -1);
        const targetTimestamp = unlockTimestamp - dynamicLeadTime;

        console.log("\n--- STRATEGI SERANGAN ---");
        console.log(`🎯 Target Balance ID : ${CONFIG.TARGET_BALANCE_ID}`);
        console.log(`⏰ Waktu Buka Kunci : ${unlockTime}`);
        console.log(`💳 Sponsor (Pembayar): ${sponsor}`);
        console.log(`📡 Latensi Rata-rata : ${avgLatency}ms`);
        console.log(`⚙️ Penyesuaian Manual: ${CONFIG.MANUAL_LEAD_TIME_ADJUSTMENT_MS}ms`);
        console.log(`💥 Waktu Tembak (UTC): ${new Date(targetTimestamp).toISOString()}`);
        console.log("--------------------------\n");

        await sendTelegramNotification(`🚀 <b>Bot Sniper Siap!</b>\nTarget: <code>${CONFIG.TARGET_BALANCE_ID}</code>\nLatensi: <code>${avgLatency}ms</code>\nWaktu Tembak: <code>${new Date(targetTimestamp).toISOString()}</code>`);

        // LANGKAH 3: PRE-BUILD TRANSAKSI
        const sponsorKeypair = await getKeypairFromMnemonic(CONFIG.SPONSOR_MNEMONIC);
        const server = new StellarSdk.Server(primaryEndpoint);
        const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
        
        const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
            fee: "100", // Fee tetap (100 stroops) untuk menghindari query tambahan saat kritis
            networkPassphrase: PI_NETWORK_PASSPHRASE,
        })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: CONFIG.TARGET_BALANCE_ID }))
        .setTimeout(30).build();
        
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

        while (Date.now() < targetTimestamp) {
            // BUSY-WAIT LOOP: Memutar loop sekencang mungkin untuk presisi maksimal.
        }

        // LANGKAH 5: SERANGAN SATURASI!
        console.log("\n💥💥💥 TEMBAK! TEMBAK! TEMBAK! 💥💥💥");
        const submissionPromises = [];
        CONFIG.API_ENDPOINTS.forEach(endpoint => {
            for (let i = 0; i < CONFIG.REQUESTS_PER_ENDPOINT; i++) {
                submissionPromises.push(submitTransaction(signedXdr, endpoint));
            }
        });

        const totalRequests = CONFIG.API_ENDPOINTS.length * CONFIG.REQUESTS_PER_ENDPOINT;
        console.log(`   -> Mengirim ${totalRequests} permintaan secara serentak...`);
        
        // LANGKAH 6: PROSES HASIL
        const results = await Promise.allSettled(submissionPromises);
        let successResult = null;
        
        results.forEach(result => {
            if (result.status === 'fulfilled' && !successResult) {
                successResult = result.value;
            }
        });

        if (successResult) {
            const successMessage = `🏆🏆🏆 <b>KLAIM BERHASIL!!!</b> 🏆🏆🏆\n\n` +
                                 `<b>Endpoint Pemenang:</b> <code>${successResult.endpoint}</code>\n` +
                                 `<b>TX Hash:</b> <code>${successResult.hash}</code>\n` +
                                 `🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${successResult.hash}">Lihat di Explorer</a>`;
            console.log("\n" + successMessage.replace(/<[^>]*>?/gm, ''));
            await sendTelegramNotification(successMessage);
        } else {
            const failMessage = `😭 <b>KLAIM GAGAL</b> 😭\n\nBot telah menembakkan ${totalRequests} transaksi tapi tidak ada yang berhasil. Kemungkinan besar kalah cepat dari bot lain.`;
            console.log("\n" + failMessage.replace(/<[^>]*>?/gm, ''));
            await sendTelegramNotification(failMessage);
        }
    } catch (error) {
        console.error("\n🚨 TERJADI KESALAHAN FATAL:", error.message);
        await sendTelegramNotification(`🚨 <b>BOT SNIPER ERROR</b>\n\nTerjadi kesalahan fatal:\n<code>${error.message}</code>`);
    }
}

main();
