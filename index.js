const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const axios = require('axios');
const fs = require('fs');
require("dotenv").config();
const { URLSearchParams } = require('url');

// ================= KONFIGURASI BOT HYBRID =================
const CONFIG = {
    // (DARI .env) Alamat tujuan akhir (Muxed Address OKX/lainnya)
    RECEIVER_ADDRESS: process.env.RECEIVER_ADDRESS,
    // (DARI .env) Mnemonic phrase dari akun SPONSOR yang akan membayar semua fee
    SPONSOR_MNEMONIC: process.env.SPONSOR_MNEMONIC,
    // (DARI .env) Memo untuk transaksi
    MEMO: process.env.MEMO || "BotHybrid",

    // API Server utama untuk patroli
    PI_API_SERVER: 'https://api.mainnet.minepi.com',
    // Jeda antar pemeriksaan dompet di pharse.txt (dalam milidetik)
    DELAY_PER_WALLET_MS: 10,
    // Jeda setelah menyelesaikan satu siklus penuh pharse.txt (dalam milidetik)
    DELAY_PER_CYCLE_MS: 60000,

    // Konfigurasi khusus untuk Mode Sniper
    SNIPER_LEAD_TIME_ADJUSTMENT_MS: -20, // Tembak 20ms lebih awal dari kalkulasi ping
    SNIPER_REQUESTS_PER_ENDPOINT: 500,     // Jumlah serangan per endpoint
    SNIPER_API_ENDPOINTS: [               // Endpoint yang akan diserang serentak
        'https://mainnet.zendshost.id',
        'https://apimainnet.vercel.app',
    ],
};
// ==========================================================

const PI_NETWORK_PASSPHRASE = 'Pi Network';
const server = new StellarSdk.Server(CONFIG.PI_API_SERVER);
const scheduledSnipes = new Map(); // Untuk melacak target sniper yang sudah dijadwalkan

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

async function getKeypairFromMnemonic(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error(`Mnemonic tidak valid: "${mnemonic.substring(0, 15)}..."`);
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

function loadTargetMnemonics() {
    try {
        if (!fs.existsSync('pharse.txt')) {
             throw new Error("File pharse.txt tidak ditemukan di direktori ini.");
        }
        const data = fs.readFileSync('pharse.txt', 'utf8');
        const lines = data.split(/\r?\n/).filter(line => line.trim() !== '');
        if (lines.length === 0) throw new Error("File pharse.txt kosong.");
        return lines;
    } catch (e) {
        throw new Error(`Gagal membaca pharse.txt: ${e.message}`);
    }
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


// --- FUNGSI SNIPER ---
async function executeSnipeAttack(target) {
    const { balanceId, unlockTime, amount, targetKeypair, sponsorKeypair, avgLatency } = target;
    console.log(`\n\n💥💥💥 MEMULAI SERANGAN SNIPER 💥💥💥`);
    console.log(`   - Target ID: ${balanceId}`);
    console.log(`   - Unlock Time: ${unlockTime}`);

    try {
        const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());

        const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
            fee: (StellarSdk.BASE_FEE * 2).toString(),
            networkPassphrase: PI_NETWORK_PASSPHRASE,
            allowMuxedAccounts: true,
        })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId, source: targetKeypair.publicKey() }))
        .addOperation(StellarSdk.Operation.payment({
            destination: CONFIG.RECEIVER_ADDRESS,
            asset: StellarSdk.Asset.native(),
            amount: amount,
            source: targetKeypair.publicKey(),
        }))
        .addMemo(StellarSdk.Memo.text(CONFIG.MEMO))
        .setTimeout(30).build();

        transaction.sign(targetKeypair);
        transaction.sign(sponsorKeypair);
        const signedXdr = transaction.toXDR();
        
        const unlockTimestamp = new Date(unlockTime).getTime();
        const dynamicLeadTime = avgLatency + (CONFIG.SNIPER_LEAD_TIME_ADJUSTMENT_MS * -1);
        const targetTimestamp = unlockTimestamp - dynamicLeadTime;
        
        console.log(`   - Waktu Tembak Terkalkulasi: ${new Date(targetTimestamp).toISOString()}`);
        
        while (Date.now() < targetTimestamp) {}
        
        console.log(`\n   - 🚀 TEMBAK SEKARANG!`);
        const submissionPromises = [];
        CONFIG.SNIPER_API_ENDPOINTS.forEach(endpoint => {
            for (let i = 0; i < CONFIG.SNIPER_REQUESTS_PER_ENDPOINT; i++) {
                submissionPromises.push(submitTransaction(signedXdr, endpoint));
            }
        });

        const results = await Promise.allSettled(submissionPromises);
        let successResult = results.find(r => r.status === 'fulfilled');

        if (successResult) {
            const successMessage = `🏆 <b>SNIPE BERHASIL!</b> 🏆\n\n` +
                                 `<b>ID:</b> <code>${balanceId}</code>\n` +
                                 `<b>Jumlah:</b> <code>${amount} π</code>\n` +
                                 `<b>TX Hash:</b> <code>${successResult.value.hash}</code>\n` +
                                 `🔗 <a href="https://blockexplorer.minepi.com/mainnet/transactions/${successResult.value.hash}">Lihat di Explorer</a>`;
            await sendTelegramNotification(successMessage);
        } else {
            await sendTelegramNotification(`😭 <b>SNIPE GAGAL</b> 😭\nID: <code>${balanceId}</code>\nKemungkinan sudah diklaim orang lain.`);
        }

    } catch (error) {
        await sendTelegramNotification(`🚨 <b>SNIPE ERROR</b>\nID: <code>${balanceId}</code>\nError: ${error.message}`);
    } finally {
        scheduledSnipes.delete(balanceId);
    }
}


// --- FUNGSI PATROLI & PENJADWALAN ---
async function processWallet(targetMnemonic, sponsorKeypair) {
    let targetKeypair;
    try {
        targetKeypair = await getKeypairFromMnemonic(targetMnemonic);
        const targetPublicKey = targetKeypair.publicKey();
        console.log(`\n🔎 Memindai wallet: ${targetPublicKey.substring(0, 12)}...`);

        const { data } = await axios.get(`${CONFIG.PI_API_SERVER}/claimable_balances?claimant=${targetPublicKey}&limit=50`);
        if (data._embedded.records.length === 0) return;

        for (const record of data._embedded.records) {
            if (record.asset !== 'native') continue;

            const { id: balanceId, amount } = record;
            if (scheduledSnipes.has(balanceId)) {
                console.log(`   - Target ${balanceId.substring(0,12)}... sudah dalam antrian sniper. Dilewati.`);
                continue;
            }

            const now = Date.now();
            let isClaimableNow = false;
            let futureUnlockTime = null;

            for (const claimant of record.claimants) {
                if (claimant.destination === targetPublicKey) {
                    const pred = claimant.predicate;
                    if (pred.unconditional === true || (pred.abs_before && new Date(pred.abs_before).getTime() > now)) {
                        isClaimableNow = true;
                        break;
                    }
                    if (pred.not && pred.not.abs_before) {
                        const unlockTimestamp = new Date(pred.not.abs_before).getTime();
                        if (unlockTimestamp <= now) {
                            isClaimableNow = true;
                        } else {
                            futureUnlockTime = pred.not.abs_before;
                        }
                        break;
                    }
                }
            }
            
            if (isClaimableNow) {
                console.log(`   - ✅ Ditemukan balance SIAP KLAIM: ${balanceId.substring(0,12)}...`);
                await claimAndForwardNow(record, targetKeypair, sponsorKeypair);
            } else if (futureUnlockTime) {
                console.log(`   - 🎯 Ditemukan TARGET SNIPER MASA DEPAN: ${balanceId.substring(0,12)}...`);
                console.log(`   - Waktu Buka Kunci: ${futureUnlockTime}`);
                
                scheduledSnipes.set(balanceId, { status: 'scheduling' });

                const avgLatency = await checkLatency(CONFIG.SNIPER_API_ENDPOINTS[0]);
                if (avgLatency === Infinity) {
                    console.error("   - Gagal mengukur latensi. Penjadwalan sniper dibatalkan.");
                    scheduledSnipes.delete(balanceId);
                    continue;
                }

                const snipeTarget = {
                    balanceId, amount, unlockTime: futureUnlockTime,
                    targetKeypair, sponsorKeypair, avgLatency
                };
                
                scheduledSnipes.set(balanceId, snipeTarget);
                
                const timeToWait = new Date(futureUnlockTime).getTime() - Date.now() - (avgLatency + 30000); // Mulai persiapan 30s sebelum tembak

                setTimeout(() => executeSnipeAttack(snipeTarget), timeToWait > 0 ? timeToWait : 0);

                await sendTelegramNotification(`🎯 <b>SNIPER DIJADWALKAN</b>\n` +
                                             `<b>ID:</b> <code>${balanceId}</code>\n` +
                                             `<b>Waktu:</b> <code>${futureUnlockTime}</code>`);
            }
        }
    } catch (error) {
        console.error(`   - ❌ GAGAL memproses wallet:`, error.response?.data?.detail || error.message);
    }
}

async function claimAndForwardNow(record, targetKeypair, sponsorKeypair) {
    console.log(`      - Mengeksekusi klaim & forward sekarang...`);
    try {
        const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
        const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
            fee: (StellarSdk.BASE_FEE * 2).toString(),
            networkPassphrase: PI_NETWORK_PASSPHRASE,
            allowMuxedAccounts: true,
        })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: record.id, source: targetKeypair.publicKey() }))
        .addOperation(StellarSdk.Operation.payment({
            destination: CONFIG.RECEIVER_ADDRESS,
            asset: StellarSdk.Asset.native(),
            amount: record.amount,
            source: targetKeypair.publicKey(),
        }))
        .addMemo(StellarSdk.Memo.text(CONFIG.MEMO))
        .setTimeout(60).build();

        transaction.sign(targetKeypair);
        transaction.sign(sponsorKeypair);

        const txResult = await server.submitTransaction(transaction);
        const successMsg = `🏆 <b>PATROLI SUKSES!</b> 🏆\n\n` +
                         `<b>Dari:</b> <code>${targetKeypair.publicKey()}</code>\n` +
                         `<b>Jumlah:</b> <code>${record.amount} π</code>\n` +
                         `<b>TX Hash:</b> <code>${txResult.hash}</code>`;
        console.log(`      - ✅ SUKSES! Hash: ${txResult.hash}`);
        await sendTelegramNotification(successMsg);
    } catch(error) {
        const errorMessage = error.response?.data?.extras?.result_codes?.transaction || error.message;
        console.error(`      - ❌ GAGAL! Alasan: ${errorMessage}`);
        await sendTelegramNotification(`❌ <b>GAGAL KLAIM PATROLI</b>\nID: <code>${record.id}</code>\nAlasan: ${errorMessage}`);
    }
}

// --- FUNGSI UTAMA BOT ---
async function main() {
    console.log("🚀 Bot Hybrid (Patroli & Sniper) Dimulai...");
    await sendTelegramNotification("🚀 <b>Bot Hybrid (Patroli & Sniper) Dimulai</b>");

    // Validasi & Setup
    if (!CONFIG.RECEIVER_ADDRESS || !CONFIG.RECEIVER_ADDRESS.startsWith('M')) throw new Error("RECEIVER_ADDRESS di .env tidak valid atau bukan Muxed Address.");
    if (!CONFIG.SPONSOR_MNEMONIC) throw new Error("SPONSOR_MNEMONIC tidak ditemukan di .env.");
    
    const targetMnemonics = loadTargetMnemonics();
    const sponsorKeypair = await getKeypairFromMnemonic(CONFIG.SPONSOR_MNEMONIC);
    
    console.log(`\nSponsor Fee Payer: ${sponsorKeypair.publicKey()}`);
    console.log(`Tujuan Akhir: ${CONFIG.RECEIVER_ADDRESS}`);
    console.log(`Ditemukan ${targetMnemonics.length} dompet target untuk dipatroli.`);
    
    // Loop Patroli Tak Terbatas
    while (true) {
        console.log("\n--- Memulai Siklus Patroli Baru ---");
        for (const [index, mnemonic] of targetMnemonics.entries()) {
            await processWallet(mnemonic, sponsorKeypair);
            if(index < targetMnemonics.length - 1) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_PER_WALLET_MS));
            }
        }
        console.log(`\n--- Siklus Patroli Selesai. Menunggu ${CONFIG.DELAY_PER_CYCLE_MS / 1} 1 ms... ---`);
        await new Promise(resolve => setTimeout(resolve, CONFIG.DELAY_PER_CYCLE_MS));
    }
}

main().catch(error => {
    console.error("\n🚨 KESALAHAN FATAL PADA BOT:", error.message);
    sendTelegramNotification(`🚨 <b>BOT BERHENTI - KESALAHAN FATAL</b>\n\n${error.message}`);
    process.exit(1);
});
