import chalk from "chalk";

export const log = {
  info: (m) => console.log(chalk.cyan("[info]") + " " + m),
  ok: (m) => console.log(chalk.green("[ok]") + " " + m),
  warn: (m) => console.log(chalk.yellow("[warn]") + " " + m),
  err: (m) => console.log(chalk.red("[err]") + " " + m),
  rat: (m) => console.log(chalk.magenta("[rat]") + " " + chalk.gray(m)),
  job: (m) => console.log(chalk.blue("[job]") + " " + m),
  tg: (m) => console.log(chalk.hex("#0088cc")("[tg]") + " " + m),
  wa: (m) => console.log(chalk.hex("#25d366")("[wa]") + " " + m),
  tt: (m) => console.log(chalk.hex("#ff0050")("[tt]") + " " + m),
  banner: () => {
    console.log(chalk.magenta.bold("\n  рџ•ЇпёЏ void reporter"));
    console.log(chalk.gray("  telegram В· whatsapp В· tiktok вЂ” max pressure\n"));
  },
};
