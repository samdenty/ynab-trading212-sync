import * as ynab from 'ynab';
import { APIClient } from 'trading212-api';
import { parse } from 'csv-parse/sync';
import crypto from 'crypto';
import { z } from 'zod';
import dayjs from 'dayjs';
import * as fs from 'fs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

// INCREMENT THIS NUMBER TO SUBMIT NEW IMPORT IDs
const IMPORT_ID_VERSION = 14;
const IMPORT_PREFIX = `T212-`;
const VERSIONED_IMPORT_PREFIX = `${IMPORT_PREFIX}v${IMPORT_ID_VERSION}:`;

export enum Trading212Action {
	Deposit = 'Deposit',
	Withdrawal = 'Withdrawal',
	MarketBuy = 'Market buy',
	MarketSell = 'Market sell',
	Dividend = 'Dividend (Dividend)',
	InterestOnCash = 'Interest on cash',
	LendingInterest = 'Lending interest',
	CurrencyConversion = 'Currency conversion',
	NewCardCost = 'New card cost',
}

const optionalString = z.string().transform((val) => (val ? val : undefined));
const optionalMoney = z.string().transform((val) => (val ? parseMoney(val) : undefined));
const optionalFloat = z.string().transform((val) => (val ? parseFloat(val) : undefined));

const Trading212TransactionSchema = z.object({
	// Core transaction details
	action: z.nativeEnum(Trading212Action),
	timestamp: z.string().transform((val) => dayjs.utc(val)),

	// Stock/Security details
	isin: optionalString,
	ticker: optionalString,
	name: optionalString,

	// Trade details
	shareCount: optionalFloat,
	pricePerShare: optionalMoney,
	pricePerShareCurrency: optionalString,
	exchangeRate: optionalFloat,

	// Financial results
	result: optionalMoney,
	resultCurrency: optionalString,
	total: z.string().transform((val) => parseMoney(val)),
	totalCurrency: optionalString,

	// Tax information
	withholdingTax: optionalMoney,
	withholdingTaxCurrency: optionalString,

	// Additional information
	notes: optionalString,
	id: z.string(),

	// Currency conversion details
	conversionFromAmount: optionalMoney,
	conversionFromCurrency: optionalString,
	conversionToAmount: optionalMoney,
	conversionToCurrency: optionalString,
	conversionFee: optionalMoney,
	conversionFeeCurrency: optionalString,
});

type Trading212Transaction = z.infer<typeof Trading212TransactionSchema>;

export async function syncAccount({ TRADING212_TOKEN, YNAB_TOKEN, ACCOUNT: account_id, BUDGET, ...env }: Env) {
	const categories = {
		stock: { category_id: env.STOCK_CATEGORY_ID || undefined },
		dividend: { category_id: env.DIVIDEND_CATEGORY_ID || undefined },
		conversionFee: { category_id: env.CONVERSION_FEE_CATEGORY_ID || undefined },
	} as const;

	const ynabAPI = new ynab.API(YNAB_TOKEN);
	const { rest: trading212API } = new APIClient(APIClient.URL_LIVE, TRADING212_TOKEN);

	const day = dayjs.utc();
	const today = day.format('YYYY-MM-DD');

	async function getTrading212Transactions(ref?: { filePath: string } | { reportId: number }) {
		let csvText: string;

		if (ref && 'filePath' in ref) {
			csvText = fs.readFileSync(ref.filePath, 'utf8');
		} else {
			ref ||= await trading212API.history.requestExport({
				dataIncluded: {
					includeDividends: true,
					includeInterest: true,
					includeOrders: true,
					includeTransactions: true,
				},
				timeFrom: day.subtract(1, 'year').toISOString(),
				timeTo: day.toISOString(),
			});

			const { reportId } = ref;

			const exportsHistory = await trading212API.history.getExports();

			const { status, downloadLink } = exportsHistory.find((e) => e.reportId === reportId) || {};

			if (status !== 'Finished' || !downloadLink) {
				return getTrading212Transactions(ref);
			}

			csvText = await fetch(downloadLink).then((res) => res.text());
		}

		const trading212Transactions: Trading212Transaction[] = parse(csvText, {
			columns: true,
			skip_empty_lines: true,
			trim: true,
		});

		return trading212Transactions.map(parseTransaction);
	}

	const trading212Transactions = await getTrading212Transactions();

	const [accountCurrency, instruments, t212Positions, payees, existingTransactions] = await Promise.all([
		trading212API.account.getInfo().then((info) => info.currencyCode),
		trading212API.metadata.getInstruments(),
		trading212API.portfolio.getOpenPosition().then(
			(positions) =>
				new Map(
					positions.map((position) => [
						position.ticker,
						{
							quantity: parseT212StockQuantity(position.quantity),
							ppl: parseMoney(position.ppl),
						},
					])
				)
		),
		ynabAPI.payees.getPayees(BUDGET).then(({ data }) => data.payees),
		ynabAPI.transactions.getTransactionsByAccount(BUDGET, account_id).then(({ data }) => data.transactions),
	]);

	const otherVersion = existingTransactions.find(
		({ import_id }) => import_id?.startsWith(IMPORT_PREFIX) && !import_id.startsWith(VERSIONED_IMPORT_PREFIX)
	);

	if (otherVersion) {
		throw new Error(
			`Found other version prefix (${otherVersion.import_id}) of T212 sync not equal to current version (${VERSIONED_IMPORT_PREFIX}...), please delete it first before proceeding to prevent duplicating transactions.`
		);
	}

	const transactionsToAdd: ynab.NewTransaction[] = [];
	const transactionsToUpdate: ynab.SaveTransactionWithIdOrImportId[] = [];

	for (const t212Transaction of trading212Transactions) {
		const date = t212Transaction.timestamp.utc().format('YYYY-MM-DD');
		const cleared: ynab.TransactionClearedStatus = 'cleared';

		const import_id = createImportId(`${t212Transaction.timestamp}:${t212Transaction.id}`);
		if (existingTransactions.some((t) => t.import_id === import_id)) {
			continue;
		}

		if (t212Transaction.totalCurrency && t212Transaction.totalCurrency !== accountCurrency) {
			console.log(
				`Skipping transaction ${t212Transaction.id} because it is in a different currency (${t212Transaction.totalCurrency}) than the account (${accountCurrency})`
			);
			continue;
		}

		switch (t212Transaction.action) {
			case Trading212Action.Deposit:
			case Trading212Action.Withdrawal: {
				transactionsToAdd.push({
					account_id,
					date,
					cleared,
					amount: t212Transaction.total,
					payee_name: t212Transaction.action,
					memo: t212Transaction.notes || null,
					import_id,
				});
				break;
			}

			case Trading212Action.InterestOnCash:
			case Trading212Action.LendingInterest: {
				transactionsToAdd.push({
					account_id,
					date,
					cleared,
					amount: t212Transaction.total,
					payee_name: 'Interest',
					memo: t212Transaction.action === Trading212Action.LendingInterest ? 'Lending interest' : null,
					flag_color: 'purple',
					approved: t212Transaction.action === Trading212Action.InterestOnCash,
					import_id,
				});
				break;
			}

			case Trading212Action.MarketBuy:
			case Trading212Action.MarketSell: {
				const isInflow = t212Transaction.action === Trading212Action.MarketSell;
				const amount = Math.abs(t212Transaction.total) * (isInflow ? 1 : -1);
				const conversionFee = t212Transaction.conversionFee ?? 0;
				const stockAmount = amount + conversionFee;

				const payee_name = `Stock: ${t212Transaction.name}`;
				const payee_id = payees.find((p) => p.name === payee_name)?.id;
				const memo = `${t212Transaction.shareCount}x ${t212Transaction.ticker} [${t212Transaction.isin}]`;

				const transaction: ynab.NewTransaction = {
					...categories.stock,
					account_id,
					date,
					cleared,
					amount,
					payee_name,
					payee_id,
					memo,
					approved: true,
					import_id,
				};

				if (conversionFee > 0) {
					transaction.subtransactions = [
						{
							...categories.stock,
							amount: stockAmount,
							payee_name,
							payee_id,
							memo,
						},
						{
							...categories.conversionFee,
							amount: -conversionFee,
							payee_name: 'Trading 212',
							memo: 'Currency conversion fee',
						},
					];
				}

				transactionsToAdd.push(transaction);
				break;
			}

			case Trading212Action.Dividend: {
				const payee_name = `Stock: ${t212Transaction.name}`;
				const payee_id = payees.find((p) => p.name === payee_name)?.id;
				const memo = `Dividend - ${t212Transaction.shareCount}x ${t212Transaction.ticker} [${t212Transaction.isin}]`;

				transactionsToAdd.push({
					...categories.dividend,
					account_id,
					date,
					cleared,
					amount: t212Transaction.total,
					payee_name,
					payee_id,
					memo,
					import_id,
				});

				break;
			}

			case Trading212Action.CurrencyConversion: {
				let amount: number;
				let payee_name: string;

				if (t212Transaction.conversionFromCurrency === accountCurrency) {
					amount = -t212Transaction.conversionFromAmount!;
					payee_name = `Exchanged to ${t212Transaction.conversionToCurrency}`;
				} else if (t212Transaction.conversionToCurrency === accountCurrency) {
					amount = t212Transaction.conversionToAmount!;
					payee_name = `Exchanged from ${t212Transaction.conversionFromCurrency}`;
				} else {
					console.log(
						`Skipping currency conversion transaction ${t212Transaction.id} because it is not in the account currency (${accountCurrency})`
					);
					break;
				}

				transactionsToAdd.push({
					account_id,
					date,
					cleared,
					amount,
					payee_name,
					memo: t212Transaction.notes || null,
					approved: true,
					import_id,
				});

				break;
			}

			case Trading212Action.NewCardCost: {
				transactionsToAdd.push({
					account_id,
					date,
					cleared,
					amount: t212Transaction.total,
					payee_name: 'Trading 212',
					memo: 'New card',
					import_id,
				});
				break;
			}
		}
	}

	const ynabPositions = new Map<string, { quantity: number; totalAmount: number; unclearedId?: string }>();

	for (const transaction of [...existingTransactions, ...transactionsToAdd]) {
		if (
			!transaction.payee_name?.startsWith('Stock:') ||
			!transaction.import_id?.startsWith(VERSIONED_IMPORT_PREFIX) ||
			transaction.memo?.startsWith('Dividend ')
		) {
			continue;
		}

		const match = transaction.memo?.match(/^([\d.]+)x.+\[(.*?)\]$/);

		if (!match) {
			throw new Error(`Could not parse memo: ${transaction.memo}`);
		}

		const quantity = parseT212StockQuantity(match[1]);
		const isin = match[2];

		const position = ynabPositions.get(isin) || { quantity: 0, totalAmount: 0 };

		if (transaction.cleared === 'cleared') {
			let transactionAmount = transaction.amount!;
			if (transaction.subtransactions?.length) {
				const stockTransaction = transaction.subtransactions.find((sub) => sub.memo?.includes('x'));
				if (stockTransaction) {
					transactionAmount = stockTransaction.amount;
				}
			}

			if (transactionAmount > 0) {
				const proportionSold = quantity / position.quantity;
				position.quantity -= quantity;
				position.totalAmount = Math.round(position.totalAmount * (1 - proportionSold));
			} else {
				position.quantity += quantity;
				position.totalAmount += Math.abs(transactionAmount);
			}
		} else if (transaction.cleared === 'uncleared' && 'id' in transaction && typeof transaction.id === 'string') {
			position.unclearedId = transaction.id;
		}

		ynabPositions.set(isin, position);
	}

	for (const [isin, ynabPosition] of ynabPositions) {
		if (ynabPosition.quantity <= 0) {
			continue;
		}

		const instrument = instruments.find((i) => i.isin === isin && t212Positions.has(i.ticker));
		if (!instrument) {
			continue;
		}

		const t212Position = t212Positions.get(instrument.ticker);

		if (!t212Position) {
			throw new Error(`No t212 position for ${instrument.ticker} [${isin}]`);
		}

		const ynabPpl = Math.round((ynabPosition.quantity / t212Position.quantity) * t212Position.ppl);
		const currentValue = ynabPosition.totalAmount + ynabPpl;
		const payee_name = `Stock: ${instrument.name}`;
		const payee_id = payees.find((p) => p.name === payee_name)?.id;

		const transaction: ynab.SaveTransactionWithIdOrImportId = {
			...categories.stock,
			account_id,
			date: today,
			cleared: 'uncleared',
			amount: currentValue,
			payee_name,
			payee_id,
			memo: `${ynabPosition.quantity / 1e10}x ${instrument.shortName} [${isin}]`,
			approved: true,
		};

		if (ynabPosition.unclearedId) {
			transaction.id = ynabPosition.unclearedId;
			transactionsToUpdate.push(transaction);
		} else {
			transaction.import_id = createImportId(`${isin}:${today}:${currentValue}`);
			transactionsToAdd.push(transaction);
		}
	}

	if (transactionsToAdd.length) {
		await ynabAPI.transactions.createTransactions(BUDGET, {
			transactions: transactionsToAdd,
		});
	}

	if (transactionsToUpdate.length) {
		await ynabAPI.transactions.updateTransactions(BUDGET, {
			transactions: transactionsToUpdate,
		});
	}
}

function parseMoney(amount: string | number) {
	return parseAmount(amount, 2, 10);
}

function parseT212StockQuantity(amount: string | number) {
	return parseAmount(amount, 10, 1);
}

function parseAmount(amount: string | number, inputPrecision: number, outputFactor: number) {
	const [fixedAmount, decimalAmount = ''] = `${amount}`.split('.');
	return parseInt(`${fixedAmount}${decimalAmount.padEnd(inputPrecision, '0')}`) * outputFactor;
}

function createImportId(data: string) {
	const hash = crypto.createHash('sha256');
	hash.update(data);

	return `${VERSIONED_IMPORT_PREFIX}${hash.digest('hex')}`.slice(0, 36);
}

function parseTransaction(data: any): Trading212Transaction {
	return Trading212TransactionSchema.parse({
		action: data.Action,
		timestamp: data.Time,
		isin: data.ISIN,
		ticker: data.Ticker,
		name: data.Name,
		shareCount: data['No. of shares'],
		pricePerShare: data['Price / share'],
		pricePerShareCurrency: data['Currency (Price / share)'],
		exchangeRate: data['Exchange rate'],
		result: data.Result,
		resultCurrency: data['Currency (Result)'],
		total: data.Total,
		totalCurrency: data['Currency (Total)'],
		withholdingTax: data['Withholding tax'],
		withholdingTaxCurrency: data['Currency (Withholding tax)'],
		notes: data.Notes,
		id: data.ID,
		conversionFromAmount: data['Currency conversion from amount'],
		conversionFromCurrency: data['Currency (Currency conversion from amount)'],
		conversionToAmount: data['Currency conversion to amount'],
		conversionToCurrency: data['Currency (Currency conversion to amount)'],
		conversionFee: data['Currency conversion fee'],
		conversionFeeCurrency: data['Currency (Currency conversion fee)'],
	});
}
