import * as fs from "fs";
import * as path from "path";

/**
 * Export ABIs and deployment addresses for consumption by the backend monorepo.
 * Outputs:
 *   ./exports/PolareonTokenPool.json
 *   ./exports/PolareonVault.json
 */

interface ContractConfig {
  name: string;
  artifactPath: string[];
  deploymentSuffix: string; // e.g. "" for TokenPool, "-vault" for Vault
}

const CONTRACTS: ContractConfig[] = [
  {
    name: "PolareonTokenPool",
    artifactPath: ["PolareonTokenPool.sol", "PolareonTokenPool.json"],
    deploymentSuffix: "",
  },
  {
    name: "PolareonVault",
    artifactPath: ["PolareonVault.sol", "PolareonVault.json"],
    deploymentSuffix: "-vault",
  },
];

async function main() {
  const exportsDir = path.join(__dirname, "..", "exports");
  if (!fs.existsSync(exportsDir)) {
    fs.mkdirSync(exportsDir, { recursive: true });
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");

  for (const contract of CONTRACTS) {
    const artifactPath = path.join(
      __dirname,
      "..",
      "artifacts",
      "contracts",
      ...contract.artifactPath,
    );

    if (!fs.existsSync(artifactPath)) {
      console.log(
        `⚠️  Skipping ${contract.name}: artifact not found. Run \`npx hardhat compile\` first.`,
      );
      continue;
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));

    // Collect deployment addresses across networks
    const addresses: Record<string, { proxy: string; implementation: string }> =
      {};

    if (fs.existsSync(deploymentsDir)) {
      const files = fs
        .readdirSync(deploymentsDir)
        .filter((f) => f.endsWith(`${contract.deploymentSuffix}.json`));
      for (const file of files) {
        const networkName = path.basename(
          file,
          `${contract.deploymentSuffix}.json`,
        );
        const data = JSON.parse(
          fs.readFileSync(path.join(deploymentsDir, file), "utf-8"),
        );
        addresses[networkName] = {
          proxy: data.proxy,
          implementation: data.implementation,
        };
      }
    }

    // Build export object
    const exported = {
      contractName: contract.name,
      abi: artifact.abi,
      addresses,
      generatedAt: new Date().toISOString(),
    };

    const exportPath = path.join(exportsDir, `${contract.name}.json`);
    fs.writeFileSync(exportPath, JSON.stringify(exported, null, 2));
    console.log(`✅ ${contract.name} → exports/${contract.name}.json`);
    console.log(
      `   Networks: ${
        Object.keys(addresses).join(", ") || "(none deployed yet)"
      }`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
