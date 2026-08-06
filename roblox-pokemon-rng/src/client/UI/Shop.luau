--!nonstrict
--[[
	Shop
	Four tabs: permanent upgrades, potions, Robux products, and Champion Rebirth.

	Prices come from the shared Upgrades module, so what the player sees is the
	same number the server charges. Nothing here sends an amount -- a purchase
	request is just an id.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Format = require(Shared.Format)
local Upgrades = require(Shared.Upgrades)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local Window = require(script.Parent.Window)
local State = require(script.Parent.Parent.State)

local Shop = {}

local window
local body
local tabButtons = {}
local activeTab = "upgrades"
local actions

local function row(parent: Instance, order: number, height: number?)
	local frame = Create("Frame", {
		LayoutOrder = order,
		Size = UDim2.new(1, 0, 0, height or 72),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 22,
		Parent = parent,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.5).Parent = frame
	return frame
end

local function renderUpgrades(parent: Instance, snapshot)
	for order, upgrade in Upgrades.list do
		local level = snapshot.upgrades[upgrade.id] or 0
		local cost = Upgrades.costFor(upgrade.id, level)
		local maxed = cost == nil

		local frame = row(parent, order)

		Theme.label({
			Text = upgrade.name,
			Font = Theme.font.heading,
			TextSize = 15,
			Position = UDim2.fromOffset(14, 10),
			Size = UDim2.new(1, -180, 0, 18),
			ZIndex = 23,
			Parent = frame,
		})

		Theme.label({
			Text = upgrade.description,
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			TextWrapped = true,
			Position = UDim2.fromOffset(14, 30),
			Size = UDim2.new(1, -190, 0, 30),
			ZIndex = 23,
			Parent = frame,
		})

		local effectText
		if upgrade.effect == "cooldown" then
			effectText = `-{Format.percent(Upgrades.effectAt(upgrade.id, level), 0)} cooldown`
		elseif upgrade.effect == "autoroll" then
			effectText = level > 0 and "unlocked" or "locked"
		else
			effectText = `+{Format.percent(Upgrades.effectAt(upgrade.id, level), 0)}`
		end

		Theme.label({
			Text = `Level {level}/{upgrade.maxLevel}  ·  {effectText}`,
			TextSize = 11,
			TextColor3 = Theme.color.accent,
			TextXAlignment = Enum.TextXAlignment.Right,
			AnchorPoint = Vector2.new(1, 0),
			Position = UDim2.new(1, -14, 0, 10),
			Size = UDim2.fromOffset(200, 16),
			ZIndex = 23,
			Parent = frame,
		})

		local affordable = not maxed and snapshot.coins >= cost
		Theme.button({
			Text = maxed and "MAXED" or `{Format.abbreviate(cost)} coins`,
			TextSize = 13,
			TextColor3 = maxed and Theme.color.subtext or (affordable and Theme.color.text or Theme.color.subtext),
			AnchorPoint = Vector2.new(1, 1),
			Position = UDim2.new(1, -14, 1, -12),
			Size = UDim2.fromOffset(150, 32),
			BackgroundColor3 = maxed and Theme.color.panel
				or (affordable and Theme.color.accentDark or Theme.color.panel),
			ZIndex = 23,
			Parent = frame,
		}, function()
			if not maxed then
				actions.buyUpgrade(upgrade.id)
			end
		end)
	end
end

local function renderPotions(parent: Instance, snapshot)
	for order, potion in Upgrades.potions do
		local owned = snapshot.potions[potion.id] or 0
		local frame = row(parent, order, 76)
		local color = Color3.fromRGB(potion.color[1], potion.color[2], potion.color[3])

		Create("Frame", {
			Size = UDim2.new(0, 4, 1, -20),
			Position = UDim2.fromOffset(0, 10),
			BackgroundColor3 = color,
			BorderSizePixel = 0,
			ZIndex = 23,
			Parent = frame,
			Theme.corner(4),
		})

		Theme.label({
			Text = potion.name,
			Font = Theme.font.heading,
			TextSize = 15,
			TextColor3 = color,
			Position = UDim2.fromOffset(16, 10),
			Size = UDim2.new(1, -230, 0, 18),
			ZIndex = 23,
			Parent = frame,
		})

		Theme.label({
			Text = `{potion.description}  ·  you have {owned}`,
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			Position = UDim2.fromOffset(16, 30),
			Size = UDim2.new(1, -230, 0, 30),
			ZIndex = 23,
			Parent = frame,
		})

		Theme.button({
			Text = `BUY {Format.abbreviate(potion.cost)}`,
			TextSize = 12,
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -104, 0.5, 0),
			Size = UDim2.fromOffset(96, 32),
			BackgroundColor3 = snapshot.coins >= potion.cost and Theme.color.accentDark or Theme.color.panel,
			ZIndex = 23,
			Parent = frame,
		}, function()
			actions.buyPotion(potion.id, "buy")
		end)

		Theme.button({
			Text = owned > 0 and "DRINK" or "BUY + USE",
			TextSize = 12,
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -14, 0.5, 0),
			Size = UDim2.fromOffset(84, 32),
			BackgroundColor3 = owned > 0 and Theme.color.success or Theme.color.panelHi,
			TextColor3 = owned > 0 and Theme.color.backdrop or Theme.color.text,
			ZIndex = 23,
			Parent = frame,
		}, function()
			actions.buyPotion(potion.id, owned > 0 and "use" or "buyuse")
		end)
	end
end

local function renderStore(parent: Instance)
	local order = 0

	for _, pass in Config.Passes do
		order += 1
		local frame = row(parent, order, 62)

		Theme.label({
			Text = pass.name,
			Font = Theme.font.heading,
			TextSize = 15,
			Position = UDim2.fromOffset(14, 10),
			Size = UDim2.new(1, -160, 0, 18),
			ZIndex = 23,
			Parent = frame,
		})

		local perks = {}
		if pass.luckMult then
			table.insert(perks, `{pass.luckMult}x luck`)
		end
		if pass.coinMult then
			table.insert(perks, `{pass.coinMult}x coins`)
		end
		if pass.cooldownMult then
			table.insert(perks, `-{Format.percent(1 - pass.cooldownMult, 0)} cooldown`)
		end
		if pass.autoRoll then
			table.insert(perks, "auto-roll unlocked")
		end

		Theme.label({
			Text = table.concat(perks, " · "),
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			Position = UDim2.fromOffset(14, 30),
			Size = UDim2.new(1, -160, 0, 18),
			ZIndex = 23,
			Parent = frame,
		})

		local configured = pass.id ~= 0
		Theme.button({
			Text = configured and "BUY" or "SOON",
			TextSize = 13,
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -14, 0.5, 0),
			Size = UDim2.fromOffset(110, 32),
			BackgroundColor3 = configured and Theme.color.success or Theme.color.panel,
			TextColor3 = configured and Theme.color.backdrop or Theme.color.subtext,
			ZIndex = 23,
			Parent = frame,
		}, function()
			if configured then
				actions.prompt("pass", pass.key)
			end
		end)
	end

	for _, product in Config.Products do
		order += 1
		local frame = row(parent, order, 54)

		Theme.label({
			Text = product.name,
			Font = Theme.font.heading,
			TextSize = 15,
			Position = UDim2.fromOffset(14, 16),
			Size = UDim2.new(1, -160, 0, 20),
			ZIndex = 23,
			Parent = frame,
		})

		local configured = product.id ~= 0
		Theme.button({
			Text = configured and "BUY" or "SOON",
			TextSize = 13,
			AnchorPoint = Vector2.new(1, 0.5),
			Position = UDim2.new(1, -14, 0.5, 0),
			Size = UDim2.fromOffset(110, 30),
			BackgroundColor3 = configured and Theme.color.coin or Theme.color.panel,
			TextColor3 = configured and Theme.color.backdrop or Theme.color.subtext,
			ZIndex = 23,
			Parent = frame,
		}, function()
			if configured then
				actions.prompt("product", product.key)
			end
		end)
	end
end

local function renderRebirth(parent: Instance, snapshot)
	local requirement = snapshot.prestigeRequirement
	local frame = row(parent, 1, 210)

	Theme.label({
		Text = "Champion Rebirth",
		Font = Theme.font.heading,
		TextSize = 20,
		Position = UDim2.fromOffset(16, 14),
		Size = UDim2.new(1, -32, 0, 24),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.label({
		Text = "Reset your trainer level, coins and upgrades in exchange for a permanent bonus.<br/>"
			.. "<b>Your collection and index are kept</b> — only progression resets.",
		TextSize = 13,
		TextColor3 = Theme.color.subtext,
		TextWrapped = true,
		Position = UDim2.fromOffset(16, 42),
		Size = UDim2.new(1, -32, 0, 44),
		ZIndex = 23,
		Parent = frame,
	})

	local levelOk = snapshot.level >= requirement.level
	local indexOk = snapshot.indexCount >= requirement.index

	Theme.label({
		Text = string.format(
			'<font color="#%s">Trainer level %d / %d</font>          <font color="#%s">Index %d / %d</font>',
			(levelOk and Theme.color.success or Theme.color.error):ToHex(),
			snapshot.level,
			requirement.level,
			(indexOk and Theme.color.success or Theme.color.error):ToHex(),
			snapshot.indexCount,
			requirement.index
		),
		TextSize = 13,
		Position = UDim2.fromOffset(16, 92),
		Size = UDim2.new(1, -32, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.label({
		Text = `Current: Rebirth {snapshot.prestige}/{requirement.max}  ·  `
			.. `+{Format.percent(snapshot.prestige * Config.Luck.PerPrestige, 0)} luck  ·  `
			.. `+{Format.percent(snapshot.prestige * Config.Prestige.CoinBonus, 0)} coins`,
		TextSize = 13,
		TextColor3 = Theme.color.accent,
		Position = UDim2.fromOffset(16, 116),
		Size = UDim2.new(1, -32, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.label({
		Text = `Next rebirth adds +{Format.percent(Config.Luck.PerPrestige, 0)} luck and `
			.. `+{Format.percent(Config.Prestige.CoinBonus, 0)} coins, permanently.`,
		TextSize = 12,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(16, 138),
		Size = UDim2.new(1, -32, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	local ready = levelOk and indexOk and snapshot.prestige < requirement.max
	Theme.button({
		Text = ready and "REBIRTH" or "REQUIREMENTS NOT MET",
		TextSize = 14,
		Position = UDim2.fromOffset(16, 164),
		Size = UDim2.new(1, -32, 0, 34),
		BackgroundColor3 = ready and Theme.color.warning or Theme.color.panel,
		TextColor3 = ready and Theme.color.backdrop or Theme.color.subtext,
		ZIndex = 23,
		Parent = frame,
	}, function()
		if ready then
			actions.prestige()
		end
	end)
end

local TABS = {
	{ id = "upgrades", label = "UPGRADES" },
	{ id = "potions", label = "POTIONS" },
	{ id = "store", label = "STORE" },
	{ id = "rebirth", label = "REBIRTH" },
}

function Shop.build(parent: Instance, handlers)
	actions = handlers
	window = Window.new(parent, "Shop", "Spend coins on permanent power")

	local tabs = Create("Frame", {
		Position = UDim2.fromOffset(12, 8),
		Size = UDim2.new(1, -24, 0, 32),
		BackgroundTransparency = 1,
		ZIndex = 21,
		Parent = window.content,
		Theme.listLayout(6, Enum.FillDirection.Horizontal),
	})

	for order, tab in TABS do
		local button
		button = Theme.button({
			Text = tab.label,
			TextSize = 12,
			Size = UDim2.fromOffset(104, 28),
			LayoutOrder = order,
			BackgroundColor3 = tab.id == activeTab and Theme.color.accentDark or Theme.color.panelAlt,
			ZIndex = 22,
			Parent = tabs,
		}, function()
			activeTab = tab.id
			for id, other in tabButtons do
				other.BackgroundColor3 = id == activeTab and Theme.color.accentDark or Theme.color.panelAlt
			end
			Shop.render()
		end)
		tabButtons[tab.id] = button
	end

	local scroller = Create("ScrollingFrame", {
		Position = UDim2.fromOffset(12, 46),
		Size = UDim2.new(1, -24, 1, -58),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.color.stroke,
		ZIndex = 21,
		Parent = window.content,
	})

	local layout = Theme.listLayout(8)
	layout.Parent = scroller
	Theme.autoCanvas(scroller, layout)
	body = scroller

	window.onOpen = function()
		Shop.render()
	end

	return window
end

function Shop.render()
	if not window or not window.visible then
		return
	end

	local snapshot = State.current
	if not snapshot then
		return
	end

	for _, child in body:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	if activeTab == "upgrades" then
		renderUpgrades(body, snapshot)
	elseif activeTab == "potions" then
		renderPotions(body, snapshot)
	elseif activeTab == "store" then
		renderStore(body)
	else
		renderRebirth(body, snapshot)
	end

	window:setSubtitle(`{Format.comma(snapshot.coins)} coins available`)
end

function Shop.toggle()
	if window then
		window:toggle()
	end
end

return Shop
