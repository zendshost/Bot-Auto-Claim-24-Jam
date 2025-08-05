const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
require("dotenv").config();
const { URLSearchParams } = require('url');

// =================== KONFIGURASI BOT ===================
const CONFIG = {
    TARGET_BALANCE_ID: process.env.TARGET_BALANCE_ID,
    UNLOCK_TIME_ISO: process.env.UNLOCK_TIME_ISO,
    AMOUNT_TO_CLAIM: process.env.AMOUNT_TO_CLAIM,
    SPONSOR_MNEMONIC: process.env.SPONSOR_MNEMONIC,
    TARGET_MNEMONIC: process.env.TARGET_MNEMONIC,
    RECEIVER_ADDRESS: process.env.RECEIVER_ADDRESS,
    FEE_PER_TRANSACTION: Math.max(200, parseInt(process.env.FEE_PER_TRANSACTION || "250", 10)).toString(), // Memastikan fee minimal 200
    SPAM_START_SECONDS_BEFORE: parseInt(process.env.SPAM_START_SECONDS_BEFORE || "1", 10),
    SPAM_DURATION_SECONDS_AFTER: parseInt(process.env.SPAM_DURATION_SECONDS_AFTER || "3", 10),
    MEMO: process.env.MEMO || "BruteForceSniper",
    API_SERVER: 'https://api.mainnet.minepi.com',
};
// ========================================================

const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(CONFIG.API_SERVER);
let isClaimed = false; // Flag untuk menghentikan spam jika sudah berhasil

// --- FUNGSI UTILITAS LENGKAP ---
async function sendTelegramNotification(message) { /* ... kode sama dari bot sebelumnya ... */ }
async function getKeypairFromMnemonic(mnemonic, name) { /* ... kode sama dari bot sebelumnya ... */ }

// --- FUNGSI UTAMA SNIPER BRUTE FORCE ---
async function main() {
    console.log("🚀 Bot Sniper Brute Force Dimulai...");
    await sendTelegramNotification(`🚀 <b>Bot Brute Force Dimulai!</b>\nTarget: <code>${CONFIG.TARGET_BALANCE_ID}</code>`);

    // Validasi input
    if (!CONFIG.SPONSOR_MNEMONIC || !CONFIG.TARGET_MNEMONIC) throw new Error("Mnemonic Sponsor dan Target wajib diisi.");
    console.log(`Biaya transaksi diatur ke: ${CONFIG.FEE_PER_TRANSACTION} stroops.`);
    if (parseInt(CONFIG.FEE_PER_TRANSACTION) < 200) {
        console.warn("PERINGATAN: Fee di bawah 200, telah diatur otomatis ke 200 stroops untuk mencegah kegagalan.");
    }
    
    try {
        // LANGKAH 1: PERSIAPKAN KUNCI
        const sponsorKeypair = await getKeypairFromMnemonic(CONFIG.SPONSOR_MNEMONIC, "Sponsor");
        const targetKeypair = await getKeypairFromMnemonic(CONFIG.TARGET_MNEMONIC, "Target");

        // LANGKAH 2: TENTUKAN JENDELA SERANGAN
        const unlockTimestamp = new Date(CONFIG.UNLOCK_TIME_ISO).getTime();
        const startTime = unlockTimestamp - (CONFIG.SPAM_START_SECONDS_BEFORE * 1000);
        const endTime = unlockTimestamp + (CONFIG.SPAM_DURATION_SECONDS_AFTER * 1000);

        console.log("\n--- STRATEGI SERANGAN BRUTE FORCE ---");
        console.log(`🎯 Target          : ${CONFIG.TARGET_BALANCE_ID}`);
        console.log(`⏰ Waktu Buka Kunci: ${CONFIG.UNLOCK_TIME_ISO}`);
        console.log(`💥 Mulai Spam      : ${new Date(startTime).toISOString()}`);
        console.log(`🛑 Berhenti Spam   : ${new Date(endTime).toISOString()}`);
        console.log("-------------------------------------\n");
        
        // LANGKAH 3: TUNGGU HINGGA JENDELA SERANGAN DIMULAI
        console.log("⏳ Menunggu jendela serangan...");
        while (Date.now() < startTime) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // LANGKAH 4: LOOP SPAM BRUTE FORCE
        console.log("\n💥💥💥 MEMASUKI JENDELA SERANGAN! MEMULAI SPAM! 💥💥💥");
        let submissionCount = 0;

        while (Date.now() < endTime && !isClaimed) {
            // Dalam setiap iterasi, kita bangun transaksi BARU dengan sequence number terbaru
            try {
                // 1. Dapatkan sequence number terbaru dari SPONSOR
                const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
                
                // 2. Bangun transaksi
                const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
                    fee: CONFIG.FEE_PER_TRANSACTION,
                    networkPassphrase: PI_NETWORK_PASSPHRASE,
                    allowMuxedAccounts: true,
                })
                .addOperation(StellarSdk.Operation.claimClaimableBalance({
                    balanceId: CONFIG.TARGET_BALANCE_ID, source: targetKeypair.publicKey(),
                }))
                .addOperation(StellarSdk.Operation.payment({
                    destination: CONFIG.RECEIVER_ADDRESS, asset: StellarSdk.Asset.native(),
                    amount: CONFIG.AMOUNT_TO_CLAIM, source: targetKeypair.publicKey(),
                }))
                .addMemo(StellarSdk.Memo.text(CONFIG.MEMO))
                .setTimeout(10).build();

                // 3. Tanda tangani
                transaction.sign(targetKeypair);
                transaction.sign(sponsorKeypair);
                
                // 4. Tembakkan! Kita tidak menunggu hasilnya, langsung loop lagi.
                server.submitTransaction(transaction)
                    .then(result => {
                        if (!isClaimed) {
                            isClaimed = true; // Hentikan semua spam
                            console.log(`\n🏆🏆🏆 BERHASIL DI-KLAIM! HASH: ${result.hash}`);
                            sendTelegramNotification(`🏆 <b>BRUTE FORCE BERHASIL!</b>\n\n<b>Hash:</b> <code>${result.hash}</code>\n🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${result.hash}">Lihat di Explorer</a>`);
                        }
                    })
                    .catch(error => {
                        // Abaikan error 'tx_failed' (karena spam sebelum waktu), tapi tampilkan error lain
                        const errorMsg = error.response?.data?.extras?.result_codes?.transaction;
                        if (errorMsg !== 'tx_failed' && !isClaimed) {
                           // console.error(` -> Gagal: ${errorMsg || error.message}`);
                        }
                    });

                submissionCount++;
                process.stdout.write(`   -> Serangan Terkirim: ${submissionCount}\r`);
                
            } catch (error) {
                // Mungkin error saat loadAccount (rate limit)
                // console.error(`\nError di dalam loop: ${error.message}`);
                await new Promise(resolve => setTimeout(resolve, 50)); // Jeda singkat jika ada error
            }
        } // Akhir dari loop while

        console.log("\n--- JENDELA SERANGAN SELESAI ---");
        
        // Cek hasil akhir setelah beberapa detik
        setTimeout(() => {
            if (isClaimed) {
                console.log("Status Akhir: BERHASIL.");
            } else {
                console.log("Status Akhir: GAGAL. Target kemungkinan sudah diklaim oleh orang lain.");
                sendTelegramNotification(`😭 <b>BRUTE FORCE GAGAL</b> 😭\nSetelah ${submissionCount} percobaan, target tidak berhasil diklaim.`);
            }
        }, 5000);

    } catch (error) {
        console.error("\n🚨 KESALAHAN FATAL:", error.message);
        await sendTelegramNotification(`🚨 <b>BOT ERROR</b>: ${error.message}`);
        process.exit(1);
    }
}

// Tambahkan definisi fungsi utilitas yang lengkap
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

main();
