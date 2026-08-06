--!strict
--[[
	Upgrades
	Everything the coin economy can be spent on: permanent upgrades bought level
	by level, and consumable potions that grant a timed buff.

	Costs and effects are pure functions of the current level so the client can
	price a purchase without asking the server, and the server can re-derive the
	same price when validating one.
]]

export type Upgrade = {
	id: string,
	name: string,
	description: string,
	maxLevel: number,
	baseCost: number,
	costGrowth: number,
	-- Per-level effect. Read by LuckService / RollService.
	effect: string,
	perLevel: number,
	icon: string,
}

export type Potion = {
	id: string,
	name: string,
	description: string,
	cost: number,
	duration: number,
	luckMult: number?,
	speedMult: number?,
	variantMult: number?,
	color: { number },
}

local Upgrades = {}

Upgrades.list = {
	{
		id = "luckCharm",
		name = "Lucky Charm",
		description = "Permanently raises your luck. Every level makes every tier easier to hit.",
		maxLevel = 25,
		baseCost = 500,
		costGrowth = 1.6,
		effect = "luck",
		perLevel = 0.10,
		icon = "clover",
	},
	{
		id = "speedTrainer",
		name = "Running Shoes",
		description = "Cuts the delay between rolls.",
		maxLevel = 12,
		baseCost = 1200,
		costGrowth = 1.75,
		effect = "cooldown",
		perLevel = 0.05,
		icon = "boot",
	},
	{
		id = "coinPouch",
		name = "Amulet Coin",
		description = "Every roll pays out more.",
		maxLevel = 20,
		baseCost = 800,
		costGrowth = 1.55,
		effect = "coins",
		perLevel = 0.12,
		icon = "coin",
	},
	{
		id = "shinyCharm",
		name = "Shiny Charm",
		description = "Improves the odds of Shiny, Alpha and Shadow variants.",
		maxLevel = 8,
		baseCost = 15000,
		costGrowth = 2.2,
		effect = "variant",
		perLevel = 0.25,
		icon = "sparkle",
	},
	{
		id = "expShare",
		name = "Exp. Share",
		description = "Earn more trainer XP from every roll.",
		maxLevel = 15,
		baseCost = 600,
		costGrowth = 1.5,
		effect = "xp",
		perLevel = 0.15,
		icon = "star",
	},
	{
		id = "autoRoll",
		name = "Auto Roller",
		description = "Unlocks hands-free rolling without waiting for trainer level 25.",
		maxLevel = 1,
		baseCost = 25000,
		costGrowth = 1,
		effect = "autoroll",
		perLevel = 1,
		icon = "loop",
	},
} :: { Upgrade }

Upgrades.byId = {} :: { [string]: Upgrade }
for _, upgrade in Upgrades.list do
	Upgrades.byId[upgrade.id] = upgrade
end

Upgrades.potions = {
	{
		id = "luck1",
		name = "Luck Potion I",
		description = "2x luck for 5 minutes.",
		cost = 750,
		duration = 300,
		luckMult = 2,
		color = { 106, 196, 122 },
	},
	{
		id = "luck2",
		name = "Luck Potion II",
		description = "5x luck for 5 minutes.",
		cost = 4000,
		duration = 300,
		luckMult = 5,
		color = { 78, 152, 236 },
	},
	{
		id = "luck3",
		name = "Luck Potion III",
		description = "15x luck for 10 minutes.",
		cost = 30000,
		duration = 600,
		luckMult = 15,
		color = { 158, 96, 226 },
	},
	{
		id = "luck4",
		name = "Master Elixir",
		description = "50x luck for 10 minutes.",
		cost = 500000,
		duration = 600,
		luckMult = 50,
		color = { 244, 168, 40 },
	},
	{
		id = "speed1",
		name = "Speed Potion",
		description = "Halves your roll cooldown for 5 minutes.",
		cost = 2000,
		duration = 300,
		speedMult = 0.5,
		color = { 236, 72, 72 },
	},
	{
		id = "shiny1",
		name = "Sparkle Spray",
		description = "3x variant odds for 5 minutes.",
		cost = 12000,
		duration = 300,
		variantMult = 3,
		color = { 255, 214, 84 },
	},
} :: { Potion }

Upgrades.potionsById = {} :: { [string]: Potion }
for _, potion in Upgrades.potions do
	Upgrades.potionsById[potion.id] = potion
end

--[[
	Cost of buying the next level of an upgrade. `currentLevel` is how many
	levels the player already owns, so the first purchase costs `baseCost`.
	Returns nil once the upgrade is maxed.
]]
function Upgrades.costFor(upgradeId: string, currentLevel: number): number?
	local upgrade = Upgrades.byId[upgradeId]
	if not upgrade then
		return nil
	end
	if currentLevel >= upgrade.maxLevel then
		return nil
	end
	return math.floor(upgrade.baseCost * upgrade.costGrowth ^ currentLevel)
end

--[[
	Total effect of owning `level` levels of an upgrade. Additive per level --
	10 levels of Lucky Charm is +100% luck, not 1.1^10.
]]
function Upgrades.effectAt(upgradeId: string, level: number): number
	local upgrade = Upgrades.byId[upgradeId]
	if not upgrade then
		return 0
	end
	return upgrade.perLevel * math.clamp(level, 0, upgrade.maxLevel)
end

return Upgrades
