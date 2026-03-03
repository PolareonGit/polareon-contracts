import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { PolareonTokenPool, MockERC20, MockFeeToken } from "../typechain-types";

// ─── Helpers ───────────────────────────────────────────────────────

const POOL_ID = ethers.keccak256(ethers.toUtf8Bytes("pool-1"));
const POOL_ID_2 = ethers.keccak256(ethers.toUtf8Bytes("pool-2"));
const CLAIM_TYPEHASH = ethers.keccak256(
  ethers.toUtf8Bytes(
    "Claim(bytes32 poolId,address user,uint256 amount,uint256 nonce)",
  ),
);

const SLOTS = 10;
const CLAIM_AMOUNT = ethers.parseUnits("100", 6); // 100 USDC
const EXPECTED_AMOUNT = CLAIM_AMOUNT * BigInt(SLOTS); // 1000 USDC

enum PoolStatus {
  Created = 0,
  Funded = 1,
  Ended = 2,
  Cancelled = 3,
  Refunded = 4,
}

async function signClaim(
  contract: PolareonTokenPool,
  operatorSigner: HardhatEthersSigner,
  poolId: string,
  user: string,
  amount: bigint,
  nonce: bigint,
): Promise<string> {
  const domain = {
    name: "PolareonTokenPool",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await contract.getAddress(),
  };

  const types = {
    Claim: [
      { name: "poolId", type: "bytes32" },
      { name: "user", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  };

  const value = { poolId, user, amount, nonce };
  return operatorSigner.signTypedData(domain, types, value);
}

// ─── Fixture ───────────────────────────────────────────────────────

async function deployFixture() {
  const [deployer, owner, operator, depositor, user1, user2, user3, attacker] =
    await ethers.getSigners();

  // Deploy mock USDC
  const MockERC20Factory = await ethers.getContractFactory("MockERC20");
  const usdc = (await MockERC20Factory.deploy(
    "USD Coin",
    "USDC",
    6,
  )) as MockERC20;

  // Deploy mock fee-on-transfer token
  const MockFeeTokenFactory = await ethers.getContractFactory("MockFeeToken");
  const feeToken = (await MockFeeTokenFactory.deploy()) as MockFeeToken;

  // Deploy PolareonTokenPool via UUPS proxy
  const Factory = await ethers.getContractFactory("PolareonTokenPool");
  const proxy = (await upgrades.deployProxy(
    Factory,
    [owner.address, operator.address],
    { initializer: "initialize", kind: "uups" },
  )) as unknown as PolareonTokenPool;

  const now = await time.latest();
  const startTime = now + 3600; // 1 hour from now
  const endTime = now + 86400; // 24 hours from now

  return {
    proxy,
    usdc,
    feeToken,
    deployer,
    owner,
    operator,
    depositor,
    user1,
    user2,
    user3,
    attacker,
    startTime,
    endTime,
  };
}

/**
 * Helper: create a pool and optionally fund it
 */
async function createAndFundPool(
  proxy: PolareonTokenPool,
  usdc: MockERC20,
  operator: HardhatEthersSigner,
  depositor: HardhatEthersSigner,
  poolId: string,
  startTime: number,
  endTime: number,
  fund = true,
) {
  await proxy
    .connect(operator)
    .createPool(
      poolId,
      await usdc.getAddress(),
      EXPECTED_AMOUNT,
      SLOTS,
      CLAIM_AMOUNT,
      startTime,
      endTime,
      depositor.address,
    );

  if (fund) {
    await usdc.mint(depositor.address, EXPECTED_AMOUNT);
    await usdc
      .connect(depositor)
      .approve(await proxy.getAddress(), EXPECTED_AMOUNT);
    await proxy.connect(depositor).deposit(poolId);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  TEST SUITE
// ═══════════════════════════════════════════════════════════════════

describe("PolareonTokenPool", function () {
  // ─── Initialization ──────────────────────────────────────────────

  describe("Initialization", function () {
    it("sets owner correctly", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);
      expect(await proxy.owner()).to.equal(owner.address);
    });

    it("sets operator correctly", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      expect(await proxy.operator()).to.equal(operator.address);
    });

    it("emits OperatorUpdated on init", async function () {
      const Factory = await ethers.getContractFactory("PolareonTokenPool");
      const [, ownerSig, opSig] = await ethers.getSigners();

      // We check the event by re-deploying
      const p = (await upgrades.deployProxy(
        Factory,
        [ownerSig.address, opSig.address],
        { initializer: "initialize", kind: "uups" },
      )) as unknown as PolareonTokenPool;

      const filter = p.filters.OperatorUpdated;
      const events = await p.queryFilter(filter);
      expect(events.length).to.equal(1);
      expect(events[0].args.newOperator).to.equal(opSig.address);
    });

    it("cannot be initialized twice", async function () {
      const { proxy, owner, operator } = await loadFixture(deployFixture);
      await expect(
        proxy.initialize(owner.address, operator.address),
      ).to.be.revertedWithCustomError(proxy, "InvalidInitialization");
    });

    it("reverts if owner is zero address", async function () {
      const Factory = await ethers.getContractFactory("PolareonTokenPool");
      const [, , opSig] = await ethers.getSigners();
      await expect(
        upgrades.deployProxy(Factory, [ethers.ZeroAddress, opSig.address], {
          initializer: "initialize",
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");
    });

    it("reverts if operator is zero address", async function () {
      const Factory = await ethers.getContractFactory("PolareonTokenPool");
      const [, ownerSig] = await ethers.getSigners();
      await expect(
        upgrades.deployProxy(Factory, [ownerSig.address, ethers.ZeroAddress], {
          initializer: "initialize",
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(Factory, "InvalidAddress");
    });
  });

  // ─── Owner Functions ─────────────────────────────────────────────

  describe("Owner Functions", function () {
    describe("setOperator", function () {
      it("owner can change operator", async function () {
        const { proxy, owner, user1 } = await loadFixture(deployFixture);
        await expect(proxy.connect(owner).setOperator(user1.address))
          .to.emit(proxy, "OperatorUpdated")
          .withArgs(await proxy.operator(), user1.address);
        expect(await proxy.operator()).to.equal(user1.address);
      });

      it("reverts if non-owner calls setOperator", async function () {
        const { proxy, operator, user1 } = await loadFixture(deployFixture);
        await expect(
          proxy.connect(operator).setOperator(user1.address),
        ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
      });

      it("reverts if setting operator to zero address", async function () {
        const { proxy, owner } = await loadFixture(deployFixture);
        await expect(
          proxy.connect(owner).setOperator(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(proxy, "InvalidAddress");
      });
    });

    describe("pause / unpause", function () {
      it("owner can pause and unpause", async function () {
        const { proxy, owner } = await loadFixture(deployFixture);
        await proxy.connect(owner).pause();
        expect(await proxy.paused()).to.be.true;
        await proxy.connect(owner).unpause();
        expect(await proxy.paused()).to.be.false;
      });

      it("non-owner cannot pause", async function () {
        const { proxy, operator } = await loadFixture(deployFixture);
        await expect(
          proxy.connect(operator).pause(),
        ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
      });

      it("paused contract blocks createPool", async function () {
        const { proxy, owner, operator, usdc, depositor, startTime, endTime } =
          await loadFixture(deployFixture);
        await proxy.connect(owner).pause();
        await expect(
          proxy
            .connect(operator)
            .createPool(
              POOL_ID,
              await usdc.getAddress(),
              EXPECTED_AMOUNT,
              SLOTS,
              CLAIM_AMOUNT,
              startTime,
              endTime,
              depositor.address,
            ),
        ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
      });

      it("paused contract blocks deposit", async function () {
        const { proxy, owner, operator, usdc, depositor, startTime, endTime } =
          await loadFixture(deployFixture);

        // Create pool while unpaused
        await proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          );

        await usdc.mint(depositor.address, EXPECTED_AMOUNT);
        await usdc
          .connect(depositor)
          .approve(await proxy.getAddress(), EXPECTED_AMOUNT);

        await proxy.connect(owner).pause();
        await expect(
          proxy.connect(depositor).deposit(POOL_ID),
        ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
      });

      it("paused contract blocks claim", async function () {
        const {
          proxy,
          owner,
          operator,
          usdc,
          depositor,
          user1,
          startTime,
          endTime,
        } = await loadFixture(deployFixture);

        await createAndFundPool(
          proxy,
          usdc,
          operator,
          depositor,
          POOL_ID,
          startTime,
          endTime,
        );
        await time.increaseTo(startTime);

        await proxy.connect(owner).pause();

        const sig = await signClaim(
          proxy,
          operator,
          POOL_ID,
          user1.address,
          CLAIM_AMOUNT,
          0n,
        );
        await expect(
          proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
        ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
      });

      it("paused contract blocks refund", async function () {
        const { proxy, owner, operator, usdc, depositor, startTime, endTime } =
          await loadFixture(deployFixture);

        await createAndFundPool(
          proxy,
          usdc,
          operator,
          depositor,
          POOL_ID,
          startTime,
          endTime,
        );
        await time.increaseTo(endTime + 1);

        await proxy.connect(owner).pause();
        await expect(
          proxy.connect(depositor).refund(POOL_ID),
        ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
      });

      it("paused contract blocks cancelPool", async function () {
        const { proxy, owner, operator, usdc, depositor, startTime, endTime } =
          await loadFixture(deployFixture);

        await proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          );

        await proxy.connect(owner).pause();
        await expect(
          proxy.connect(operator).cancelPool(POOL_ID),
        ).to.be.revertedWithCustomError(proxy, "EnforcedPause");
      });
    });
  });

  // ─── createPool ──────────────────────────────────────────────────

  describe("createPool", function () {
    it("operator creates a pool successfully", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      )
        .to.emit(proxy, "PoolCreated")
        .withArgs(
          POOL_ID,
          await usdc.getAddress(),
          EXPECTED_AMOUNT,
          SLOTS,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.tokenAddress).to.equal(await usdc.getAddress());
      expect(pool.status).to.equal(PoolStatus.Created);
      expect(pool.totalSlots).to.equal(SLOTS);
      expect(pool.claimedSlots).to.equal(0);
      expect(pool.expectedAmount).to.equal(EXPECTED_AMOUNT);
      expect(pool.claimAmount).to.equal(CLAIM_AMOUNT);
      expect(pool.depositedAmount).to.equal(0);
      expect(pool.startTime).to.equal(startTime);
      expect(pool.endTime).to.equal(endTime);
      expect(pool.authorizedDepositor).to.equal(depositor.address);
    });

    it("reverts if non-operator calls createPool", async function () {
      const { proxy, user1, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);
      await expect(
        proxy
          .connect(user1)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "OnlyOperator");
    });

    it("reverts if poolId already exists", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await proxy
        .connect(operator)
        .createPool(
          POOL_ID,
          await usdc.getAddress(),
          EXPECTED_AMOUNT,
          SLOTS,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "PoolAlreadyExists");
    });

    it("reverts if tokenAddress is zero", async function () {
      const { proxy, operator, depositor, startTime, endTime } =
        await loadFixture(deployFixture);
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            ethers.ZeroAddress,
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidAddress");
    });

    it("reverts if expectedAmount is zero", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            0,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });

    it("reverts if slots is zero", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            0,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidSlots");
    });

    it("reverts if claimAmount is zero", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            0,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });

    it("reverts if endTime <= startTime", async function () {
      const { proxy, operator, usdc, depositor, startTime } = await loadFixture(
        deployFixture,
      );
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            startTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidTimeWindow");
    });

    it("reverts if authorizedDepositor is zero", async function () {
      const { proxy, operator, usdc, startTime, endTime } = await loadFixture(
        deployFixture,
      );
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            EXPECTED_AMOUNT,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            ethers.ZeroAddress,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidAddress");
    });

    it("reverts if expectedAmount < slots * claimAmount", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);
      const tooSmall = CLAIM_AMOUNT * BigInt(SLOTS) - 1n;
      await expect(
        proxy
          .connect(operator)
          .createPool(
            POOL_ID,
            await usdc.getAddress(),
            tooSmall,
            SLOTS,
            CLAIM_AMOUNT,
            startTime,
            endTime,
            depositor.address,
          ),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });
  });

  // ─── deposit ─────────────────────────────────────────────────────

  describe("deposit", function () {
    it("authorized depositor deposits successfully", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await proxy
        .connect(operator)
        .createPool(
          POOL_ID,
          await usdc.getAddress(),
          EXPECTED_AMOUNT,
          SLOTS,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      await usdc.mint(depositor.address, EXPECTED_AMOUNT);
      await usdc
        .connect(depositor)
        .approve(await proxy.getAddress(), EXPECTED_AMOUNT);

      await expect(proxy.connect(depositor).deposit(POOL_ID))
        .to.emit(proxy, "Deposited")
        .withArgs(POOL_ID, depositor.address, EXPECTED_AMOUNT);

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Funded);
      expect(pool.depositedAmount).to.equal(EXPECTED_AMOUNT);
    });

    it("reverts if pool not found", async function () {
      const { proxy, depositor } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(depositor).deposit(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotFound");
    });

    it("reverts if pool is not in Created status", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );

      // Try depositing again (pool is now Funded)
      await usdc.mint(depositor.address, EXPECTED_AMOUNT);
      await usdc
        .connect(depositor)
        .approve(await proxy.getAddress(), EXPECTED_AMOUNT);
      await expect(
        proxy.connect(depositor).deposit(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotCreated");
    });

    it("reverts if caller is not authorized depositor", async function () {
      const { proxy, operator, usdc, depositor, attacker, startTime, endTime } =
        await loadFixture(deployFixture);

      await proxy
        .connect(operator)
        .createPool(
          POOL_ID,
          await usdc.getAddress(),
          EXPECTED_AMOUNT,
          SLOTS,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      await usdc.mint(attacker.address, EXPECTED_AMOUNT);
      await usdc
        .connect(attacker)
        .approve(await proxy.getAddress(), EXPECTED_AMOUNT);

      await expect(
        proxy.connect(attacker).deposit(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "OnlyAuthorizedDepositor");
    });

    it("reverts with fee-on-transfer token", async function () {
      const { proxy, operator, feeToken, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      const feeExpected = ethers.parseEther("1000");
      await proxy
        .connect(operator)
        .createPool(
          POOL_ID,
          await feeToken.getAddress(),
          feeExpected,
          10,
          ethers.parseEther("100"),
          startTime,
          endTime,
          depositor.address,
        );

      await feeToken.mint(depositor.address, feeExpected);
      await feeToken
        .connect(depositor)
        .approve(await proxy.getAddress(), feeExpected);

      await expect(
        proxy.connect(depositor).deposit(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "FeeOnTransferNotSupported");
    });
  });

  // ─── claim ───────────────────────────────────────────────────────

  describe("claim", function () {
    it("user claims successfully with valid signature", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      const nonce = await proxy.nonces(user1.address);
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        nonce,
      );

      const balanceBefore = await usdc.balanceOf(user1.address);
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, nonce, sig),
      )
        .to.emit(proxy, "Claimed")
        .withArgs(POOL_ID, user1.address, CLAIM_AMOUNT);

      expect(await usdc.balanceOf(user1.address)).to.equal(
        balanceBefore + CLAIM_AMOUNT,
      );
      expect(await proxy.hasClaimed(POOL_ID, user1.address)).to.be.true;
      expect(await proxy.getClaimedSlots(POOL_ID)).to.equal(1);
      expect(await proxy.nonces(user1.address)).to.equal(nonce + 1n);
    });

    it("multiple users can claim", async function () {
      const {
        proxy,
        operator,
        usdc,
        depositor,
        user1,
        user2,
        startTime,
        endTime,
      } = await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      // User 1 claims
      const sig1 = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig1);

      // User 2 claims
      const sig2 = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user2.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user2).claim(POOL_ID, CLAIM_AMOUNT, 0, sig2);

      expect(await proxy.getClaimedSlots(POOL_ID)).to.equal(2);
    });

    it("auto-transitions to Ended when all slots claimed", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      // Pool with 2 slots
      const slots = 2;
      const claimAmt = ethers.parseUnits("100", 6);
      const total = claimAmt * BigInt(slots);
      const poolId = ethers.keccak256(ethers.toUtf8Bytes("small-pool"));

      await proxy
        .connect(operator)
        .createPool(
          poolId,
          await usdc.getAddress(),
          total,
          slots,
          claimAmt,
          startTime,
          endTime,
          depositor.address,
        );

      await usdc.mint(depositor.address, total);
      await usdc.connect(depositor).approve(await proxy.getAddress(), total);
      await proxy.connect(depositor).deposit(poolId);

      await time.increaseTo(startTime);

      const signers = await ethers.getSigners();
      for (let i = 0; i < slots; i++) {
        const user = signers[4 + i]; // skip deployer, owner, operator, depositor
        const nonce = await proxy.nonces(user.address);
        const sig = await signClaim(
          proxy,
          operator,
          poolId,
          user.address,
          claimAmt,
          nonce,
        );
        await proxy.connect(user).claim(poolId, claimAmt, nonce, sig);
      }

      const pool = await proxy.getPool(poolId);
      expect(pool.status).to.equal(PoolStatus.Ended);
      expect(pool.claimedSlots).to.equal(slots);
    });

    it("reverts if pool not found", async function () {
      const { proxy, user1, operator } = await loadFixture(deployFixture);
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "PoolNotFound");
    });

    it("reverts if pool is not funded", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      // Create but don't fund
      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );
      await time.increaseTo(startTime);

      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "PoolNotClaimable");
    });

    it("reverts before startTime", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      // Don't advance time

      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "PoolNotClaimable");
    });

    it("reverts after endTime", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(endTime + 1);

      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "PoolNotClaimable");
    });

    it("reverts if amount != claimAmount", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      const wrongAmount = CLAIM_AMOUNT + 1n;
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        wrongAmount,
        0n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, wrongAmount, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "InvalidClaimAmount");
    });

    it("reverts on double claim", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      const sig1 = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig1);

      // Second claim attempt
      const sig2 = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        1n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 1, sig2),
      ).to.be.revertedWithCustomError(proxy, "AlreadyClaimed");
    });

    it("reverts with wrong nonce", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      const wrongNonce = 99n;
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        wrongNonce,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, wrongNonce, sig),
      ).to.be.revertedWithCustomError(proxy, "NonceMismatch");
    });

    it("reverts with invalid signature (wrong signer)", async function () {
      const {
        proxy,
        operator,
        usdc,
        depositor,
        user1,
        attacker,
        startTime,
        endTime,
      } = await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      // Attacker signs instead of operator
      const sig = await signClaim(
        proxy,
        attacker,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "InvalidSignature");
    });

    it("reverts if user tries someone else's signature", async function () {
      const {
        proxy,
        operator,
        usdc,
        depositor,
        user1,
        user2,
        startTime,
        endTime,
      } = await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      // Signature for user1
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      // user2 tries to use it
      await expect(
        proxy.connect(user2).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "InvalidSignature");
    });

    it("signature from old operator is invalid after rotation", async function () {
      const {
        proxy,
        owner,
        operator,
        usdc,
        depositor,
        user1,
        user2,
        startTime,
        endTime,
      } = await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      // Sign with old operator
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );

      // Rotate operator
      await proxy.connect(owner).setOperator(user2.address);

      // Old signature should fail
      await expect(
        proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig),
      ).to.be.revertedWithCustomError(proxy, "InvalidSignature");
    });
  });

  // ─── cancelPool ──────────────────────────────────────────────────

  describe("cancelPool", function () {
    it("operator cancels a Created pool", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );

      await expect(proxy.connect(operator).cancelPool(POOL_ID))
        .to.emit(proxy, "PoolCancelled")
        .withArgs(POOL_ID);

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Cancelled);
    });

    it("operator cancels a Funded pool (no claims)", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );

      await expect(proxy.connect(operator).cancelPool(POOL_ID))
        .to.emit(proxy, "PoolCancelled")
        .withArgs(POOL_ID);

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Cancelled);
    });

    it("reverts if non-operator cancels", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );

      await expect(
        proxy.connect(user1).cancelPool(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "OnlyOperator");
    });

    it("reverts if pool not found", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(operator).cancelPool(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotFound");
    });

    it("reverts if pool has claims", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      // Make a claim
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig);

      // Try to cancel — should fail because pool is now Ended or Funded with claims
      await expect(
        proxy.connect(operator).cancelPool(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolHasClaims");
    });

    it("reverts if pool is already Ended", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      // Pool with 1 slot
      const poolId = ethers.keccak256(ethers.toUtf8Bytes("one-slot"));
      const total = CLAIM_AMOUNT;
      await proxy
        .connect(operator)
        .createPool(
          poolId,
          await usdc.getAddress(),
          total,
          1,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      await usdc.mint(depositor.address, total);
      await usdc.connect(depositor).approve(await proxy.getAddress(), total);
      await proxy.connect(depositor).deposit(poolId);

      await time.increaseTo(startTime);

      const [, , , , user] = await ethers.getSigners();
      const sig = await signClaim(
        proxy,
        operator,
        poolId,
        user.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user).claim(poolId, CLAIM_AMOUNT, 0, sig);

      // Pool is now Ended
      await expect(
        proxy.connect(operator).cancelPool(poolId),
      ).to.be.revertedWithCustomError(proxy, "PoolNotCreated");
    });

    it("reverts if pool is Cancelled", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );
      await proxy.connect(operator).cancelPool(POOL_ID);

      await expect(
        proxy.connect(operator).cancelPool(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotCreated");
    });
  });

  // ─── refund ──────────────────────────────────────────────────────

  describe("refund", function () {
    it("refunds full amount for cancelled funded pool", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await proxy.connect(operator).cancelPool(POOL_ID);

      const balanceBefore = await usdc.balanceOf(depositor.address);
      await expect(proxy.connect(depositor).refund(POOL_ID))
        .to.emit(proxy, "Refunded")
        .withArgs(POOL_ID, depositor.address, EXPECTED_AMOUNT);

      expect(await usdc.balanceOf(depositor.address)).to.equal(
        balanceBefore + EXPECTED_AMOUNT,
      );

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Refunded);
    });

    it("refunds remaining after some claims (pool ended by time)", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      // 1 claim
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig);

      // Wait for end
      await time.increaseTo(endTime + 1);

      const expected = EXPECTED_AMOUNT - CLAIM_AMOUNT; // 9 * 100 = 900
      const balanceBefore = await usdc.balanceOf(depositor.address);
      await expect(proxy.connect(depositor).refund(POOL_ID))
        .to.emit(proxy, "Refunded")
        .withArgs(POOL_ID, depositor.address, expected);

      expect(await usdc.balanceOf(depositor.address)).to.equal(
        balanceBefore + expected,
      );
    });

    it("refund transitions Funded → Ended → Refunded when past endTime", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(endTime + 1);

      await proxy.connect(depositor).refund(POOL_ID);

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Refunded);
    });

    it("reverts if pool not found", async function () {
      const { proxy, depositor } = await loadFixture(deployFixture);
      await expect(
        proxy.connect(depositor).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotFound");
    });

    it("reverts if caller is not depositor", async function () {
      const { proxy, operator, usdc, depositor, attacker, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await proxy.connect(operator).cancelPool(POOL_ID);

      await expect(
        proxy.connect(attacker).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "OnlyAuthorizedDepositor");
    });

    it("reverts if pool is Funded but not past endTime", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );

      await expect(
        proxy.connect(depositor).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotRefundable");
    });

    it("reverts if pool is Created (no deposit, not cancelled)", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );

      await expect(
        proxy.connect(depositor).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotRefundable");
    });

    it("reverts if cancelled but no deposit was made", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );
      await proxy.connect(operator).cancelPool(POOL_ID);

      await expect(
        proxy.connect(depositor).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotRefundable");
    });

    it("reverts on double refund", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await proxy.connect(operator).cancelPool(POOL_ID);
      await proxy.connect(depositor).refund(POOL_ID);

      await expect(
        proxy.connect(depositor).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotRefundable");
    });

    it("reverts if all slots claimed (nothing to refund)", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      // 1-slot pool
      const poolId = ethers.keccak256(ethers.toUtf8Bytes("full-pool"));
      await proxy
        .connect(operator)
        .createPool(
          poolId,
          await usdc.getAddress(),
          CLAIM_AMOUNT,
          1,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      await usdc.mint(depositor.address, CLAIM_AMOUNT);
      await usdc
        .connect(depositor)
        .approve(await proxy.getAddress(), CLAIM_AMOUNT);
      await proxy.connect(depositor).deposit(poolId);
      await time.increaseTo(startTime);

      const [, , , , user] = await ethers.getSigners();
      const sig = await signClaim(
        proxy,
        operator,
        poolId,
        user.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user).claim(poolId, CLAIM_AMOUNT, 0, sig);

      // All claimed — remaining is 0
      await expect(
        proxy.connect(depositor).refund(poolId),
      ).to.be.revertedWithCustomError(proxy, "InvalidAmount");
    });
  });

  // ─── View Functions ──────────────────────────────────────────────

  describe("View Functions", function () {
    it("getPool returns correct data", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.tokenAddress).to.equal(await usdc.getAddress());
      expect(pool.status).to.equal(PoolStatus.Funded);
      expect(pool.totalSlots).to.equal(SLOTS);
      expect(pool.depositedAmount).to.equal(EXPECTED_AMOUNT);
    });

    it("getPoolBalance returns correct remaining", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      expect(await proxy.getPoolBalance(POOL_ID)).to.equal(EXPECTED_AMOUNT);

      // After 1 claim
      await time.increaseTo(startTime);
      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig);

      expect(await proxy.getPoolBalance(POOL_ID)).to.equal(
        EXPECTED_AMOUNT - CLAIM_AMOUNT,
      );
    });

    it("getPoolBalance returns 0 for non-existent pool", async function () {
      const { proxy } = await loadFixture(deployFixture);
      expect(await proxy.getPoolBalance(POOL_ID)).to.equal(0);
    });

    it("getPoolBalance returns 0 after refund", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await proxy.connect(operator).cancelPool(POOL_ID);
      await proxy.connect(depositor).refund(POOL_ID);

      expect(await proxy.getPoolBalance(POOL_ID)).to.equal(0);
    });

    it("isPoolActive returns correct values at each stage", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      // Created (not funded)
      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );
      expect(await proxy.isPoolActive(POOL_ID)).to.be.false;

      // Fund it
      await usdc.mint(depositor.address, EXPECTED_AMOUNT);
      await usdc
        .connect(depositor)
        .approve(await proxy.getAddress(), EXPECTED_AMOUNT);
      await proxy.connect(depositor).deposit(POOL_ID);

      // Funded but before startTime
      expect(await proxy.isPoolActive(POOL_ID)).to.be.false;

      // Active
      await time.increaseTo(startTime);
      expect(await proxy.isPoolActive(POOL_ID)).to.be.true;

      // Past endTime
      await time.increaseTo(endTime + 1);
      expect(await proxy.isPoolActive(POOL_ID)).to.be.false;
    });

    it("getClaimedSlots returns correct count", async function () {
      const {
        proxy,
        operator,
        usdc,
        depositor,
        user1,
        user2,
        startTime,
        endTime,
      } = await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      expect(await proxy.getClaimedSlots(POOL_ID)).to.equal(0);

      const sig1 = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig1);
      expect(await proxy.getClaimedSlots(POOL_ID)).to.equal(1);

      const sig2 = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user2.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user2).claim(POOL_ID, CLAIM_AMOUNT, 0, sig2);
      expect(await proxy.getClaimedSlots(POOL_ID)).to.equal(2);
    });

    it("hasClaimed returns false then true", async function () {
      const { proxy, operator, usdc, depositor, user1, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );
      await time.increaseTo(startTime);

      expect(await proxy.hasClaimed(POOL_ID, user1.address)).to.be.false;

      const sig = await signClaim(
        proxy,
        operator,
        POOL_ID,
        user1.address,
        CLAIM_AMOUNT,
        0n,
      );
      await proxy.connect(user1).claim(POOL_ID, CLAIM_AMOUNT, 0, sig);

      expect(await proxy.hasClaimed(POOL_ID, user1.address)).to.be.true;
    });

    it("domainSeparator returns a non-zero value", async function () {
      const { proxy } = await loadFixture(deployFixture);
      const sep = await proxy.domainSeparator();
      expect(sep).to.not.equal(ethers.ZeroHash);
    });
  });

  // ─── UUPS Upgrade ────────────────────────────────────────────────

  describe("UUPS Upgrade", function () {
    it("owner can upgrade the implementation", async function () {
      const { proxy, owner } = await loadFixture(deployFixture);

      const Factory = await ethers.getContractFactory(
        "PolareonTokenPool",
        owner,
      );
      const upgraded = await upgrades.upgradeProxy(
        await proxy.getAddress(),
        Factory,
        {
          kind: "uups",
        },
      );

      // Contract still works
      expect(await upgraded.owner()).to.equal(owner.address);
    });

    it("non-owner cannot upgrade", async function () {
      const { proxy, operator } = await loadFixture(deployFixture);

      const Factory = await ethers.getContractFactory(
        "PolareonTokenPool",
        operator,
      );
      await expect(
        upgrades.upgradeProxy(await proxy.getAddress(), Factory, {
          kind: "uups",
        }),
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });

    it("state persists across upgrades", async function () {
      const { proxy, owner, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      // Create a pool before upgrade
      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );

      // Upgrade
      const Factory = await ethers.getContractFactory(
        "PolareonTokenPool",
        owner,
      );
      const upgraded = (await upgrades.upgradeProxy(
        await proxy.getAddress(),
        Factory,
        { kind: "uups" },
      )) as unknown as PolareonTokenPool;

      // Pool state should persist
      const pool = await upgraded.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Funded);
      expect(pool.depositedAmount).to.equal(EXPECTED_AMOUNT);
      expect(await upgraded.operator()).to.equal(operator.address);
    });
  });

  // ─── Full Lifecycle Integration ──────────────────────────────────

  describe("Full Lifecycle", function () {
    it("create → deposit → claims → end → refund remaining", async function () {
      const {
        proxy,
        operator,
        usdc,
        depositor,
        user1,
        user2,
        user3,
        startTime,
        endTime,
      } = await loadFixture(deployFixture);

      // 1. Create pool
      await proxy
        .connect(operator)
        .createPool(
          POOL_ID,
          await usdc.getAddress(),
          EXPECTED_AMOUNT,
          SLOTS,
          CLAIM_AMOUNT,
          startTime,
          endTime,
          depositor.address,
        );

      let pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Created);

      // 2. Deposit
      await usdc.mint(depositor.address, EXPECTED_AMOUNT);
      await usdc
        .connect(depositor)
        .approve(await proxy.getAddress(), EXPECTED_AMOUNT);
      await proxy.connect(depositor).deposit(POOL_ID);

      pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Funded);

      // 3. Claims (3 users claim)
      await time.increaseTo(startTime);

      for (const user of [user1, user2, user3]) {
        const nonce = await proxy.nonces(user.address);
        const sig = await signClaim(
          proxy,
          operator,
          POOL_ID,
          user.address,
          CLAIM_AMOUNT,
          nonce,
        );
        await proxy.connect(user).claim(POOL_ID, CLAIM_AMOUNT, nonce, sig);
      }

      expect(await proxy.getClaimedSlots(POOL_ID)).to.equal(3);
      expect(await proxy.getPoolBalance(POOL_ID)).to.equal(
        EXPECTED_AMOUNT - CLAIM_AMOUNT * 3n,
      );

      // 4. End (time passes)
      await time.increaseTo(endTime + 1);

      // 5. Refund remaining (7 unclaimed slots)
      const expectedRefund = CLAIM_AMOUNT * 7n;
      await expect(proxy.connect(depositor).refund(POOL_ID))
        .to.emit(proxy, "Refunded")
        .withArgs(POOL_ID, depositor.address, expectedRefund);

      pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Refunded);
      expect(await proxy.getPoolBalance(POOL_ID)).to.equal(0);
    });

    it("create → deposit → cancel → refund (no claims)", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
      );

      await proxy.connect(operator).cancelPool(POOL_ID);
      let pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Cancelled);

      await proxy.connect(depositor).refund(POOL_ID);
      pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Refunded);
      expect(await usdc.balanceOf(depositor.address)).to.equal(EXPECTED_AMOUNT);
    });

    it("create → cancel (no deposit, no refund needed)", async function () {
      const { proxy, operator, usdc, depositor, startTime, endTime } =
        await loadFixture(deployFixture);

      await createAndFundPool(
        proxy,
        usdc,
        operator,
        depositor,
        POOL_ID,
        startTime,
        endTime,
        false,
      );

      await proxy.connect(operator).cancelPool(POOL_ID);

      const pool = await proxy.getPool(POOL_ID);
      expect(pool.status).to.equal(PoolStatus.Cancelled);

      // Refund should revert — no deposit to refund
      await expect(
        proxy.connect(depositor).refund(POOL_ID),
      ).to.be.revertedWithCustomError(proxy, "PoolNotRefundable");
    });
  });
});
