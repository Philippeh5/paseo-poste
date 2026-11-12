// FreqTrade Launcher Bridge for Paseo Lab Dashboard
// Lance les stratégies FreqTrade depuis le poste de commande

import { execSync } from "node:child_process";
import { spawn } from "node:child_process";

const FREQTRADE_USERDIR = "/home/ubuntu/Projets/freqtrade/user_data";

export async function launchFreqTrade(strategy, config, mode, pairs) {
  try {
    const cmdMap = {
      backtest: "backtesting",
      trade: "trade", 
      hyperopt: "hyperopt"
    };
    
    const modeArgs = {
      backtest: "--timerange 20250101-20250131",
      trade: "",
      hyperopt: "--max-trials 10"
    };
    
    const pairFlag = pairs && pairs.length > 0 ? `-p ${pairs.join(" ")}` : "";
    const strategyFlag = `--strategy ${strategy}`;
    const configFlag = config ? `--config ${config}` : "";
    const userdirFlag = `--userdir ${FREQTRADE_USERDIR}`;
    
    const command = `freqtrade ${cmdMap[mode]} ${modeArgs[mode]} --strategy ${strategy} --config ${config} --userdir ${FREQTRADE_USERDIR} ${pairFlag}`;
    
    // Utiliser spawn pour un meilleur contrôle
    const result = await new Promise((resolve, reject) => {
      const proc = spawn("freqtrade", [
        cmdMap[mode], 
        modeArgs[mode], 
        "--strategy", strategy,
        "--config", config || "config.json",
        "--userdir", FREQTRADE_USERDIR
      ], { shell: true, env: process.env });
      
      let stdout = "";
      let stderr = "";
      
      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });
      
      proc.on("close", (code) => {
        resolve({
          success: code === 0,
          output: stdout,
          error: stderr,
          exitCode: code
        });
      });
      
      proc.on("error", (err) => {
        reject(err);
      });
    });
    
    return {
      success: result.success,
      output: result.output,
      error: result.error,
      mode,
      strategy,
      config
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: "",
      mode,
      strategy,
      config
    };
  }
}

// Helper: Lancer un backtest FreqTrade
export async function runFreqTradeBacktest(strategy, config, pairs) {
  return launchFreqTrade(strategy, config, "backtest", pairs);
}

// Helper: Lancer le bot en mode normal
export async function runFreqTradeTrade(strategy, config, pairs) {
  return launchFreqTrade(strategy, config, "trade", pairs);
}

// Helper: Lancer l'optimisation HyperOpt
export async function runFreqTradeHyperOpt(strategy, config, pairs) {
  return launchFreqTrade(strategy, config, "hyperopt", pairs);
}

