--!nonstrict
--[[
	HUD
	The always-on interface: currency and level, current luck, the roll button,
	the cooldown bar, active potions, the recent-roll feed and the nav bar.

	The cooldown shown here is a local prediction. The server is the authority
	and will simply ignore an early request, but a bar that only moved when the
	server said so would stutter on every ping spike -- so the client runs its
	own copy of the same timer and re-syncs it whenever a roll actually lands.
]]

local UserInputService = game:GetService("UserInputService")
local RunService = game:GetService("RunService")
local TweenService = game:GetService("TweenService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Format = require(Shared.Format)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local State = require(script.Parent.Parent.State)

local HUD = {}

local widgets = {}
local actions

-- Local cooldown prediction.
local cooldownEndsAt = 0
local cooldownLength = 0
local autoEnabled = false

--------------------------------------------------------------------------------
-- Construction
--------------------------------------------------------------------------------

local function statCard(parent: Instance)
	local frame = Create("Frame", {
		Name = "Stats",
		Position = UDim2.fromOffset(14, 14),
		Size = UDim2.fromOffset(232, 96),
		BackgroundColor3 = Theme.color.panel,
		BackgroundTransparency = 0.08,
		BorderSizePixel = 0,
		ZIndex = 10,
		Parent = parent,
	})
	Theme.corner(12).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.3).Parent = frame
	Theme.padding(12).Parent = frame

	widgets.coins = Theme.label({
		Text = "0",
		Font = Theme.font.heading,
		TextSize = 22,
		TextColor3 = Theme.color.coin,
		Size = UDim2.new(1, 0, 0, 26),
		ZIndex = 11,
		Parent = frame,
	})

	widgets.level = Theme.label({
		Text = "Trainer level 1",
		TextSize = 13,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(0, 30),
		Size = UDim2.new(1, 0, 0, 16),
		ZIndex = 11,
		Parent = frame,
	})

	local track, setXp = Theme.bar(Theme.color.xp, 7)
	track.Position = UDim2.fromOffset(0, 50)
	track.ZIndex = 11
	track.Parent = frame
	widgets.setXp = setXp

	widgets.rolls = Theme.label({
		Text = "0 rolls",
		TextSize = 12,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(0, 60),
		Size = UDim2.new(1, 0, 0, 16),
		ZIndex = 11,
		Parent = frame,
	})
end

local function luckCard(parent: Instance)
	local frame = Create("Frame", {
		Name = "Luck",
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -14, 0, 14),
		Size = UDim2.fromOffset(216, 60),
		BackgroundColor3 = Theme.color.panel,
		BackgroundTransparency = 0.08,
		BorderSizePixel = 0,
		ZIndex = 10,
		Parent = parent,
	})
	Theme.corner(12).Parent = frame
	Theme.stroke(Theme.color.accent, 1.5, 0.4).Parent = frame
	Theme.padding(10).Parent = frame

	Theme.label({
		Text = "LUCK",
		Font = Theme.font.heading,
		TextSize = 11,
		TextColor3 = Theme.color.subtext,
		Size = UDim2.new(1, 0, 0, 14),
		ZIndex = 11,
		Parent = frame,
	})

	widgets.luck = Theme.label({
		Text = "1x",
		Font = Theme.font.heading,
		TextSize = 24,
		TextColor3 = Theme.color.accent,
		Position = UDim2.fromOffset(0, 14),
		Size = UDim2.new(1, 0, 0, 28),
		ZIndex = 11,
		Parent = frame,
	})

	-- The breakdown is a hover panel rather than a click target: it is
	-- reference information, and a player mid-roll should never have to close
	-- something to keep playing.
	local detail = Create("Frame", {
		Name = "Breakdown",
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, 0, 1, 8),
		Size = UDim2.fromOffset(216, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		Visible = false,
		ZIndex = 12,
		Parent = frame,
	})
	Theme.corner(10).Parent = detail
	Theme.stroke(Theme.color.stroke, 1, 0.3).Parent = detail
	Theme.padding(10).Parent = detail
	Theme.listLayout(3).Parent = detail
	widgets.luckDetail = detail

	frame.MouseEnter:Connect(function()
		detail.Visible = true
	end)
	frame.MouseLeave:Connect(function()
		detail.Visible = false
	end)

	widgets.effects = Create("Frame", {
		Name = "Effects",
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -14, 0, 82),
		Size = UDim2.fromOffset(216, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundTransparency = 1,
		ZIndex = 10,
		Parent = parent,
		Create("UIListLayout", {
			Padding = UDim.new(0, 4),
			SortOrder = Enum.SortOrder.LayoutOrder,
			HorizontalAlignment = Enum.HorizontalAlignment.Right,
		}),
	})
end

local function rollControls(parent: Instance)
	local holder = Create("Frame", {
		Name = "RollControls",
		AnchorPoint = Vector2.new(0.5, 1),
		Position = UDim2.new(0.5, 0, 1, -18),
		Size = UDim2.fromOffset(320, 96),
		BackgroundTransparency = 1,
		ZIndex = 10,
		Parent = parent,
	})

	widgets.rollButton = Theme.button({
		Name = "Roll",
		Text = "ROLL",
		TextSize = 26,
		Size = UDim2.new(1, 0, 0, 58),
		BackgroundColor3 = Theme.color.accentDark,
		ZIndex = 11,
		Parent = holder,
	}, function()
		actions.roll()
	end)

	local track, setCooldown, fill = Theme.bar(Theme.color.accent, 6)
	track.Position = UDim2.fromOffset(0, 62)
	track.ZIndex = 11
	track.Parent = holder
	widgets.setCooldown = setCooldown
	widgets.cooldownFill = fill

	widgets.autoButton = Theme.button({
		Name = "Auto",
		Text = "AUTO: OFF",
		TextSize = 13,
		Position = UDim2.fromOffset(0, 74),
		Size = UDim2.new(1, 0, 0, 24),
		BackgroundColor3 = Theme.color.panelHi,
		ZIndex = 11,
		Parent = holder,
	}, function()
		actions.toggleAuto(not autoEnabled)
	end)
end

local function navBar(parent: Instance)
	local bar = Create("Frame", {
		Name = "Nav",
		AnchorPoint = Vector2.new(0, 1),
		Position = UDim2.new(0, 14, 1, -18),
		Size = UDim2.fromOffset(236, 92),
		BackgroundTransparency = 1,
		ZIndex = 10,
		Parent = parent,
		Theme.gridLayout(UDim2.fromOffset(73, 42), 8),
	})

	local entries = {
		{ key = "bag", label = "BAG" },
		{ key = "index", label = "INDEX" },
		{ key = "shop", label = "SHOP" },
		{ key = "board", label = "BOARD" },
		{ key = "daily", label = "DAILY" },
		{ key = "settings", label = "MORE" },
	}

	for order, entry in entries do
		Theme.button({
			Text = entry.label,
			TextSize = 14,
			LayoutOrder = order,
			BackgroundColor3 = Theme.color.panel,
			ZIndex = 11,
			Parent = bar,
		}, function()
			actions.nav(entry.key)
		end)
	end
end

local function rollFeed(parent: Instance)
	local frame = Create("Frame", {
		Name = "Feed",
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -14, 0.5, 0),
		Size = UDim2.fromOffset(214, 260),
		BackgroundColor3 = Theme.color.panel,
		BackgroundTransparency = 0.2,
		BorderSizePixel = 0,
		ZIndex = 10,
		Parent = parent,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.5).Parent = frame
	Theme.padding(8).Parent = frame

	Theme.label({
		Text = "RECENT",
		Font = Theme.font.heading,
		TextSize = 11,
		TextColor3 = Theme.color.subtext,
		Size = UDim2.new(1, 0, 0, 14),
		ZIndex = 11,
		Parent = frame,
	})

	widgets.feed = Create("Frame", {
		Position = UDim2.fromOffset(0, 18),
		Size = UDim2.new(1, 0, 1, -18),
		BackgroundTransparency = 1,
		ClipsDescendants = true,
		ZIndex = 11,
		Parent = frame,
		Theme.listLayout(3),
	})
end

local function warningBanner(parent: Instance)
	widgets.warning = Theme.label({
		Name = "ReadOnlyWarning",
		Text = "Save unavailable — progress this session will NOT be kept.",
		Font = Theme.font.heading,
		TextSize = 13,
		TextXAlignment = Enum.TextXAlignment.Center,
		TextColor3 = Theme.color.backdrop,
		BackgroundColor3 = Theme.color.error,
		BackgroundTransparency = 0,
		AnchorPoint = Vector2.new(0.5, 0),
		Position = UDim2.new(0.5, 0, 0, 0),
		Size = UDim2.fromOffset(520, 26),
		Visible = false,
		ZIndex = 45,
		Parent = parent,
		Theme.corner(0),
	})
end

function HUD.build(parent: Instance, handlers)
	actions = handlers

	statCard(parent)
	luckCard(parent)
	rollControls(parent)
	navBar(parent)
	rollFeed(parent)
	warningBanner(parent)

	-- Space bar rolls, which is what every player tries within ten seconds.
	UserInputService.InputBegan:Connect(function(input, processed)
		if processed then
			return
		end
		if input.KeyCode == Enum.KeyCode.Space then
			actions.roll()
		elseif input.KeyCode == Enum.KeyCode.E then
			actions.toggleAuto(not autoEnabled)
		end
	end)

	RunService.RenderStepped:Connect(HUD.tick)
end

--------------------------------------------------------------------------------
-- Rendering
--------------------------------------------------------------------------------

function HUD.render(snapshot)
	if not widgets.coins then
		return
	end

	widgets.coins.Text = `{Format.comma(snapshot.coins)} coins`

	if snapshot.level >= snapshot.maxLevel then
		widgets.level.Text = `Trainer level {snapshot.level} (max)`
		widgets.setXp(1)
	else
		widgets.level.Text = `Trainer level {snapshot.level}`
		widgets.setXp(snapshot.xpNeeded > 0 and snapshot.xp / snapshot.xpNeeded or 0)
	end

	local rollsText = `{Format.comma(snapshot.rolls)} rolls`
	if snapshot.prestige > 0 then
		rollsText ..= `  ·  Rebirth {snapshot.prestige}`
	end
	widgets.rolls.Text = rollsText

	widgets.luck.Text = Format.multiplier(snapshot.luck)

	-- Breakdown rows.
	for _, child in widgets.luckDetail:GetChildren() do
		if child:IsA("TextLabel") then
			child:Destroy()
		end
	end
	for order, row in snapshot.luckBreakdown do
		local value = row.kind == "mult" and Format.multiplier(row.value)
			or `+{Format.percent(row.value, 0)}`
		Theme.label({
			Text = `<font color="#9AA2B6">{row.label}</font>  {value}`,
			TextSize = 12,
			LayoutOrder = order,
			Size = UDim2.new(1, 0, 0, 15),
			ZIndex = 13,
			Parent = widgets.luckDetail,
		})
	end

	-- Active potions.
	for _, child in widgets.effects:GetChildren() do
		if not child:IsA("UIListLayout") then
			child:Destroy()
		end
	end
	for order, effect in snapshot.effects do
		local chip = Create("Frame", {
			Size = UDim2.fromOffset(216, 22),
			BackgroundColor3 = Theme.color.panelAlt,
			BackgroundTransparency = 0.1,
			BorderSizePixel = 0,
			LayoutOrder = order,
			ZIndex = 11,
			Parent = widgets.effects,
		})
		Theme.corner(6).Parent = chip

		Theme.label({
			Text = `  {effect.name}`,
			TextSize = 12,
			Size = UDim2.new(1, -60, 1, 0),
			ZIndex = 12,
			Parent = chip,
		})
		Theme.label({
			Text = Format.duration(effect.remaining),
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			TextXAlignment = Enum.TextXAlignment.Right,
			AnchorPoint = Vector2.new(1, 0),
			Position = UDim2.new(1, -8, 0, 0),
			Size = UDim2.fromOffset(56, 22),
			ZIndex = 12,
			Parent = chip,
		})
	end

	autoEnabled = snapshot.settings.autoRoll == true
	widgets.autoButton.Text = autoEnabled and "AUTO: ON" or "AUTO: OFF"
	widgets.autoButton.BackgroundColor3 = autoEnabled and Theme.color.success or Theme.color.panelHi
	widgets.autoButton.TextColor3 = autoEnabled and Theme.color.backdrop or Theme.color.text

	if not snapshot.autoRollUnlocked then
		widgets.autoButton.Text = "AUTO: LOCKED"
		widgets.autoButton.BackgroundColor3 = Theme.color.panelHi
		widgets.autoButton.TextColor3 = Theme.color.subtext
	end

	widgets.warning.Visible = snapshot.readOnly == true

	cooldownLength = snapshot.cooldown
end

--[[
	Called when a roll actually lands, to re-anchor the predicted cooldown to
	the server's timing.
]]
function HUD.onRoll(result)
	local snapshot = State.current
	cooldownLength = snapshot and snapshot.cooldown or cooldownLength
	cooldownEndsAt = os.clock() + cooldownLength

	HUD.pushFeed(result)
end

function HUD.pushFeed(result)
	if not widgets.feed then
		return
	end

	local species = Species.byId[result.speciesId]
	if not species then
		return
	end

	local color = Theme.rarityGlow(result.tier)
	local variantName = RollEngine.variantDisplayName(result.variantKey or "")
	local label = variantName ~= "" and `{variantName} {result.name}` or result.name

	local row = Theme.label({
		Text = `<font color="#{color:ToHex()}">{label}</font>  <font color="#7A8298">{Format.rarity(result.effectiveRarity)}</font>`,
		TextSize = 12,
		Size = UDim2.new(1, 0, 0, 16),
		LayoutOrder = -math.floor(os.clock() * 1000),
		ZIndex = 12,
		Parent = widgets.feed,
	})

	row.TextTransparency = 1
	TweenService:Create(row, TweenInfo.new(0.2), { TextTransparency = 0 }):Play()

	-- Trim to what fits, oldest first.
	local rows = {}
	for _, child in widgets.feed:GetChildren() do
		if child:IsA("TextLabel") then
			table.insert(rows, child)
		end
	end
	if #rows > 14 then
		table.sort(rows, function(a, b)
			return a.LayoutOrder < b.LayoutOrder
		end)
		for i = 15, #rows do
			rows[i]:Destroy()
		end
	end
end

function HUD.tick()
	if not widgets.setCooldown then
		return
	end

	local remaining = cooldownEndsAt - os.clock()
	if remaining <= 0 or cooldownLength <= 0 then
		widgets.setCooldown(1)
		widgets.rollButton.Text = "ROLL"
		widgets.rollButton.TextColor3 = Theme.color.text
	else
		widgets.setCooldown(1 - remaining / cooldownLength)
		widgets.rollButton.Text = string.format("%.1fs", remaining)
		widgets.rollButton.TextColor3 = Theme.color.subtext
	end
end

function HUD.canRoll(): boolean
	return os.clock() >= cooldownEndsAt
end

return HUD
