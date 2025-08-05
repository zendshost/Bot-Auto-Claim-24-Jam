const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();
const { URLSearchParams } = require('url');

// ================= KONFIGURASI BOT SWEEPER =================
const CONFIG = {
    // (DARI .env) Alamat tujuan akhir (Muxed Address OKX/lainnya)
    RECEIVER_ADDRESS: process.env.RECEIVER_ADDRESS,
    // (DARI .env) Mnemonic phrase dari akun SPONSOR yang akan membayar semua fee
    SPONSOR_MNEMONIC: process.env.SPONSOR_MNEMONIC,
    // (DARI .env) Memo untuk transaksi forwarder
    MEMO: process.env.MEMO || "BotSweeper",
    
    // API Server Pi Network
    PI_API_SERVER: 'https://mainnet.zendshost.id',

    // Jeda antara pemeriksaan setiap wallet di pharse.txt (dalam milidetik)
    // Jangan set terlalu rendah untuk menghindari rate limit dari API
    DELAY_PER_WALLET_MS: 50, // 50 ms

    // Jeda setelah menyelesaikan satu siklus penuh pharse.txt (dalam milidetik)
    DELAY_PER_CYCLE_MS: 60000, // 1 menit
};
// ==========================================================

const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(CONFIG.PI_API_SERVER);

// Fungsi Kirim Notifikasi ke Telegram
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

// Fungsi Mendapatkan Keypair dari Mnemonic
async function getKeypairFromMnemonic(mnemonic) {
    if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
        throw new Error("Mnemonic tidak valid.");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

// Fungsi Membaca file pharse.txt
function loadTargetMnemonics() {
    try {
        const data = fs.readFileSync('pharse.txt', 'utf8');
        const lines = data.split(/\r?\n/).filter(line => line.trim() !== '');
        if (lines.length === 0) throw new Error("File pharse.txt kosong atau tidak ada mnemonic yang valid.");
        console.log(`✅ Ditemukan ${lines.length} target wallet di pharse.txt.`);
        return lines;
    } catch (e) {
        throw new Error(`Gagal membaca pharse.txt: ${e.message}`);
    }
}

// Fungsi utama untuk memproses satu wallet target
async function processWallet(targetMnemonic, sponsorKeypair) {
    let targetKeypair;
    try {
        targetKeypair = await getKeypairFromMnemonic(targetMnemonic);
        const targetPublicKey = targetKeypair.publicKey();
        console.log(`\n🔎 Memindai wallet: ${targetPublicKey.substring(0, 12)}...`);

        // 1. Cari claimable balances untuk wallet target
        const { data } = await axios.get(`${CONFIG.PI_API_SERVER}/claimable_balances?claimant=${targetPublicKey}&limit=50`);
        
        const claimableRecords = data._embedded.records;
        if (claimableRecords.length === 0) {
            console.log("   - Tidak ada claimable balance ditemukan.");
            return;
        }

        console.log(`   - Ditemukan ${claimableRecords.length} claimable balance. Memeriksa status...`);

        for (const record of claimableRecords) {
            const { id: balanceId, amount, asset } = record;

            // Pastikan asetnya adalah Pi (native)
            if (asset !== 'native') {
                console.log(`   - Melewati balance ${balanceId} (bukan Pi native).`);
                continue;
            }

            // 2. Cek apakah sudah bisa di-klaim SEKARANG
            const now = new Date();
            let isClaimableNow = false;
            for (const claimant of record.claimants) {
                if (claimant.destination === targetPublicKey) {
                    const predicate = claimant.predicate;
                    // Kondisi 1: Jika bisa diklaim sebelum tanggal X (dan X belum lewat)
                    if (predicate.abs_before && new Date(predicate.abs_before) > now) {
                        isClaimableNow = true;
                        break;
                    }
                    // Kondisi 2: Jika TIDAK bisa diklaim sebelum tanggal X (artinya lock-up berakhir)
                    if (predicate.not && predicate.not.abs_before && new Date(predicate.not.abs_before) <= now) {
                        isClaimableNow = true;
                        break;
                    }
                    // Kondisi 3: Unconditional (bisa diklaim kapan saja)
                    if (predicate.unconditional === true) {
                        isClaimableNow = true;
                        break;
                    }
                }
            }

            if (!isClaimableNow) {
                console.log(`   - Balance ${balanceId.substring(0,12)}... belum bisa diklaim saat ini.`);
                continue;
            }

            console.log(`   - ✅ Ditemukan balance yang siap klaim! ID: ${balanceId}, Jumlah: ${amount} π`);
            
            // 3. Bangun transaksi (Claim + Payment)
            console.log("      - Membangun transaksi gabungan (Claim + Forward)...");
            const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
            
            // PENTING: Akun target harus sudah ada di blockchain (funded) untuk bisa mengirim.
            // Jika tidak, operasi Payment akan gagal.

            const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
                fee: (StellarSdk.BASE_FEE * 2).toString(), // Fee untuk 2 operasi
                networkPassphrase: PI_NETWORK_PASSPHRASE,
                allowMuxedAccounts: true, // WAJIB untuk mengirim ke M-address
            })
            // Operasi 1: Klaim dana ke wallet target
            .addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId: balanceId,
                source: targetPublicKey, // Operasi ini dijalankan atas nama target
            }))
            // Operasi 2: Kirim semua dana yang baru diklaim ke tujuan akhir
            .addOperation(StellarSdk.Operation.payment({
                destination: CONFIG.RECEIVER_ADDRESS,
                asset: StellarSdk.Asset.native(),
                amount: amount, // Kirim seluruh jumlah yang diklaim
                source: targetPublicKey, // Dana dikirim DARI wallet target
            }))
            .addMemo(StellarSdk.Memo.text(CONFIG.MEMO))
            .setTimeout(60)
            .build();

            // 4. Tanda tangani dengan DUA kunci
            console.log("      - Menandatangani dengan kunci target & sponsor...");
            transaction.sign(targetKeypair);   // Target memberi izin mengirim dana
            transaction.sign(sponsorKeypair);  // Sponsor memberi izin membayar fee

            // 5. Kirim transaksi
            console.log("      - Mengirim transaksi ke jaringan...");
            const txResult = await server.submitTransaction(transaction);
            
            const successMsg = `🏆 <b>KLAIM & FORWARD SUKSES!</b> 🏆\n\n` +
                             `<b>Dari (Target):</b> <code>${targetPublicKey}</code>\n` +
                             `<b>Ke (Tujuan Akhir):</b> <code>${CONFIG.RECEIVER_ADDRESS}</code>\n` +
                             `<b>Jumlah:</b> <code>${amount} π</code>\n` +
                             `<b>Memo:</b> <code>${CONFIG.MEMO}</code>\n` +
                             `<b>TX Hash:</b> <code>${txResult.hash}</code>\n` +
                             `🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${txResult.hash}">Lihat di Explorer</a>`;
            
            console.log(`      - ✅ SUKSES! Hash: ${txResult.hash}`);
            await sendTelegramNotification(successMsg);

        }
    } catch (error) {
        const walletId = targetKeypair ? targetKeypair.publicKey() : "Unknown";
        console.error(`   - ❌ GAGAL memproses wallet ${walletId}:`, error.response ? error.response.data : error.message);
        await sendTelegramNotification(`❌ <b>GAGAL PROSES</b>\nWallet: <code>${walletId}</code>\nAlasan: ${error.message}`);
    }
}

// Fungsi utama Bot
async function main() {
    console.log("🚀 Bot Sweeper & Forwarder Pi Dimulai...");
    await sendTelegramNotification("🚀 <b>Bot Sweeper & Forwarder Dimulai</b>");

    // Validasi input awal
    if (!CONFIG.RECEIVER_ADDRESS || !CONFIG.RECEIVER_ADDRESS.startsWith('M')) {
        throw new Error("RECEIVER_ADDRESS di .env tidak valid atau bukan Muxed Address.");
    }
    if (!CONFIG.SPONSOR_MNEMONIC) {
        throw new Error("SPONSOR_MNEMONIC tidak ditemukan di .env.");
    }
    
    const targetMnemonics = loadTargetMnemonics();
    const sponsorKeypair = await getKeypairFromMnemonic(CONFIG.SPONSOR_MNEMONIC);
    
    console.log(`\nSponsor Fee Payer: ${sponsorKeypair.publicKey()}`);
    console.log(`Tujuan Akhir: ${CONFIG.RECEIVER_ADDRESS}`);
    
    // Loop tak terbatas
    while (true) {
        console.log("\n--- Memulai Siklus Pemindaian Baru ---");
        for (const [index, mnemonic] of targetMnemonics.entries()) {
            await processWallet(mnemonic, sponsorKeypair);
            if (index < targetMnemonics.length - 1) {
                console.log(`   ... menunggu ${CONFIG.DELAY_PER_WALLET_MS / 1} 1 ms ...`);
                await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_PER_WALLET_MS));
            }
        }
        console.log(`\n--- Siklus Selesai. Menunggu ${CONFIG.DELAY_PER_CYCLE_MS / 1000 / 60} menit sebelum memulai lagi ---`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_PER_CYCLE_MS));
    }
}

main().catch(error => {
    console.error("🚨 KESALAHAN FATAL PADA BOT:", error.message);
    sendTelegramNotification(`🚨 <b>BOT BERHENTI - KESALAHAN FATAL</b>\n\n${error.message}`);
    process.exit(1);
});
