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
    FEE_PER_TRANSACTION: Math.max(200, parseInt(process.env.FEE_PER_TRANSACTION || "50", 10)).toString(),
    SPAM_START_SECONDS_BEFORE: parseFloat(process.env.SPAM_START_SECONDS_BEFORE || "1.5"),
    SPAM_DURATION_SECONDS_AFTER: parseInt(process.env.SPAM_DURATION_SECONDS_AFTER || "3", 10),
    MEMO: process.env.MEMO || "AtomicSniper",
    API_SERVER: 'https://mainnet.zendshost.id',
};
// ========================================================

const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(CONFIG.API_SERVER);
let isClaimed = false; // Flag global untuk menghentikan semua aktivitas setelah sukses

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

// --- FUNGSI UTAMA SNIPER ---
async function main() {
    console.log("🚀 Bot Sniper Atomik Dimulai...");
    
    // Validasi input dari .env
    const requiredVars = ['TARGET_BALANCE_ID', 'UNLOCK_TIME_ISO', 'AMOUNT_TO_CLAIM', 'SPONSOR_MNEMONIC', 'TARGET_MNEMONIC', 'RECEIVER_ADDRESS'];
    for (const v of requiredVars) {
        if (!CONFIG[v]) {
            const errorMsg = `Variabel wajib "${v}" tidak ditemukan di file .env. Bot berhenti.`;
            console.error(`🚨 ${errorMsg}`);
            await sendTelegramNotification(errorMsg);
            process.exit(1);
        }
    }
    await sendTelegramNotification(`🚀 <b>Bot Sniper Atomik Dimulai!</b>\nTarget: <code>${CONFIG.TARGET_BALANCE_ID}</code>`);
    console.log(`Biaya transaksi diatur ke: ${CONFIG.FEE_PER_TRANSACTION} stroops.`);

    try {
        // PERSIAPAN KUNCI
        console.log("🔑 Mempersiapkan kunci...");
        const sponsorKeypair = await getKeypairFromMnemonic(CONFIG.SPONSOR_MNEMONIC, "Sponsor");
        const targetKeypair = await getKeypairFromMnemonic(CONFIG.TARGET_MNEMONIC, "Target");

        // PENENTUAN JENDELA SERANGAN
        const unlockTimestamp = new Date(CONFIG.UNLOCK_TIME_ISO).getTime();
        const startTime = unlockTimestamp - (CONFIG.SPAM_START_SECONDS_BEFORE * 1000);
        const endTime = unlockTimestamp + (CONFIG.SPAM_DURATION_SECONDS_AFTER * 1000);

        console.log("\n--- STRATEGI SERANGAN ---");
        console.log(`🎯 Target          : ${CONFIG.TARGET_BALANCE_ID}`);
        console.log(`⏰ Waktu Buka Kunci: ${new Date(unlockTimestamp).toISOString()}`);
        console.log(`💥 Mulai Spam      : ${new Date(startTime).toISOString()}`);
        console.log(`🛑 Berhenti Spam   : ${new Date(endTime).toISOString()}`);
        console.log("-------------------------------------\n");
        
        // TUNGGU HINGGA JENDELA SERANGAN
        console.log("⏳ Menunggu jendela serangan...");
        while (Date.now() < startTime) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        // MEMULAI LOOP SPAM
        console.log("\n💥💥💥 MEMASUKI JENDELA SERANGAN! MEMULAI SPAM! 💥💥💥");
        let submissionCount = 0;
        let sponsorAccount;

        // Memuat akun Sponsor SEKALI SEBELUM loop untuk efisiensi
        try {
            sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
            console.log(`✅ Akun Sponsor berhasil dimuat. Sequence saat ini: ${sponsorAccount.sequence}`);
        } catch(e) {
            throw new Error(`Gagal memuat akun Sponsor. Kemungkinan akun belum aktif (saldo < 1 Pi) atau masalah koneksi. Error: ${e.message}`);
        }
        
        while (Date.now() < endTime && !isClaimed) {
            submissionCount++;
            
            // Menaikkan sequence number secara manual untuk transaksi berikutnya
            sponsorAccount.incrementSequenceNumber();

            //  ========================================================================
            //  BAGIAN INTI: MEMBANGUN TRANSAKSI DENGAN DUA OPERASI (CLAIM + PAYMENT)
            //  ========================================================================
            const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
                fee: CONFIG.FEE_PER_TRANSACTION,
                networkPassphrase: PI_NETWORK_PASSPHRASE,
                allowMuxedAccounts: true,
            })
            // OPERASI #1: KLAIM SALDO
            .addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId: CONFIG.TARGET_BALANCE_ID, 
                source: targetKeypair.publicKey(), // Operasi ini dijalankan atas nama akun TARGET
            }))
            // OPERASI #2: KIRIM PEMBAYARAN
            .addOperation(StellarSdk.Operation.payment({
                destination: CONFIG.RECEIVER_ADDRESS, 
                asset: StellarSdk.Asset.native(),
                amount: CONFIG.AMOUNT_TO_CLAIM, 
                source: targetKeypair.publicKey(), // Dana dikirim DARI akun TARGET
            }))
            .addMemo(StellarSdk.Memo.text(CONFIG.MEMO))
            .setTimeout(10).build();

            // MENANDATANGANI TRANSAKSI DENGAN DUA KUNCI
            transaction.sign(targetKeypair);  // Tanda tangan TARGET untuk mengizinkan operasi dari akunnya
            transaction.sign(sponsorKeypair); // Tanda tangan SPONSOR untuk membayar biaya transaksi
            
            // Mengirim transaksi ke jaringan
            server.submitTransaction(transaction)
                .then(result => {
                    if (!isClaimed) {
                        isClaimed = true;
                        console.log(`\n\n🏆🏆🏆 BERHASIL! HASH: ${result.hash}`);
                        sendTelegramNotification(`🏆 <b>TRANSAKSI ATOMIK BERHASIL!</b>\n\n<b>Hash:</b> <code>${result.hash}</code>\n🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${result.hash}">Lihat di Explorer</a>`);
                    }
                })
                .catch(error => {
                    // Abaikan error spamming
                });

            process.stdout.write(`   -> Serangan Terkirim: ${submissionCount}\r`);
            await new Promise(resolve => setTimeout(resolve, 5)); 
        }

        console.log("\n\n--- JENDELA SERANGAN SELESAI ---");
        
        // Cek hasil akhir setelah beberapa detik
        setTimeout(async () => {
            if (isClaimed) {
                console.log("Status Akhir: BERHASIL.");
            } else {
                console.log("Status Akhir: GAGAL. Kemungkinan target sudah diklaim atau ada masalah konfigurasi.");
                await sendTelegramNotification(`😭 <b>GAGAL</b> 😭\nSetelah ${submissionCount} percobaan, target tidak berhasil diklaim.`);
            }
        }, 5000);

    } catch (error) {
        console.error("\n🚨 KESALAHAN FATAL:", error.message);
        await sendTelegramNotification(`🚨 <b>BOT ERROR</b>: ${error.message}`);
        process.exit(1);
    }
}

main();
