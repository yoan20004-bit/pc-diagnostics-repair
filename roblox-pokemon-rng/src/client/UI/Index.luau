--!nonstrict
--[[
	Index
	The Pokedex: every species in the game, discovered or not.

	Undiscovered entries still show their dex number, tier and odds. Hiding the
	odds would make the index useless as a target list, and the whole point of
	an RNG game's collection screen is to show you what you are hunting.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Format = require(Shared.Format)
local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local Window = require(script.Parent.Window)
local State = require(script.Parent.Parent.State)

local Index = {}

local window
local grid
local summary
local filterTier = "all"

local function tile(species, discovered: boolean, parent: Instance, order: number, luck: number)
	local tier = Rarity.get(species.tier)
	local color = Theme.rarityColor(species.tier)

	local frame = Create("Frame", {
		LayoutOrder = order,
		BackgroundColor3 = discovered and Theme.color.panelAlt or Theme.color.panel,
		BackgroundTransparency = discovered and 0 or 0.4,
		BorderSizePixel = 0,
		ZIndex = 22,
		Parent = parent,
	})
	Theme.corner(8).Parent = frame
	Theme.stroke(discovered and color or Theme.color.stroke, 1, discovered and 0.2 or 0.7).Parent = frame

	Theme.label({
		Text = Format.dex(species.id),
		TextSize = 10,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(8, 6),
		Size = UDim2.new(1, -16, 0, 12),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.label({
		Text = discovered and species.name or "???",
		Font = Theme.font.heading,
		TextSize = 13,
		TextColor3 = discovered and Theme.color.text or Theme.color.subtext,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Position = UDim2.fromOffset(8, 18),
		Size = UDim2.new(1, -16, 0, 16),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.label({
		Text = discovered and table.concat(species.types, " / ") or tier.name,
		TextSize = 10,
		TextColor3 = color,
		Position = UDim2.fromOffset(8, 35),
		Size = UDim2.new(1, -16, 0, 12),
		ZIndex = 23,
		Parent = frame,
	})

	-- Odds are quoted at the player's current luck, so the panel doubles as a
	-- readout of what their potions are actually buying them.
	Theme.label({
		Text = Format.rarity(RollEngine.speciesRarity(species.id, luck)),
		TextSize = 10,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(8, 48),
		Size = UDim2.new(1, -16, 0, 12),
		ZIndex = 23,
		Parent = frame,
	})
end

function Index.build(parent: Instance)
	window = Window.new(parent, "Index", "Every creature in the game")

	local toolbar = Create("Frame", {
		Position = UDim2.fromOffset(12, 8),
		Size = UDim2.new(1, -24, 0, 32),
		BackgroundTransparency = 1,
		ZIndex = 21,
		Parent = window.content,
		Theme.listLayout(5, Enum.FillDirection.Horizontal),
	})

	local buttons = {}
	local function addFilter(id: string, label: string, order: number, color: Color3?)
		local button
		button = Theme.button({
			Text = label,
			TextSize = 11,
			Size = UDim2.fromOffset(id == "all" and 44 or 78, 26),
			LayoutOrder = order,
			BackgroundColor3 = Theme.color.panelAlt,
			TextColor3 = color or Theme.color.text,
			ZIndex = 22,
			Parent = toolbar,
		}, function()
			filterTier = id
			for otherId, other in buttons do
				other.BackgroundColor3 = otherId == id and Theme.color.accentDark or Theme.color.panelAlt
			end
			Index.render()
		end)
		buttons[id] = button
		if id == filterTier then
			button.BackgroundColor3 = Theme.color.accentDark
		end
	end

	addFilter("all", "ALL", 0)
	for order, tier in Rarity.tiers do
		addFilter(tier.id, string.upper(tier.name), order, Theme.rarityColor(tier.id))
	end

	summary = Theme.label({
		Text = "",
		TextSize = 12,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(12, 44),
		Size = UDim2.new(1, -24, 0, 16),
		ZIndex = 22,
		Parent = window.content,
	})

	local scroller = Create("ScrollingFrame", {
		Position = UDim2.fromOffset(12, 64),
		Size = UDim2.new(1, -24, 1, -76),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.color.stroke,
		ZIndex = 21,
		Parent = window.content,
	})

	grid = Theme.gridLayout(UDim2.fromOffset(126, 66), 8)
	grid.Parent = scroller
	Theme.autoCanvas(scroller, grid)

	window.onOpen = function()
		Index.render()
	end

	return window
end

function Index.render()
	if not window or not window.visible then
		return
	end

	local snapshot = State.current
	if not snapshot then
		return
	end

	local parent = grid.Parent
	for _, child in parent:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	local luck = snapshot.luck or Config.Luck.Base
	local order = 0
	for _, species in Species.list do
		if filterTier == "all" or species.tier == filterTier then
			order += 1
			tile(species, State.isDiscovered(species.id), parent, order, luck)
		end
	end

	window:setSubtitle(
		`{snapshot.indexCount}/{snapshot.indexTotal} discovered  ·  {snapshot.tiersComplete} tiers complete  ·  {snapshot.typesMastered} types mastered`
	)

	-- Type mastery is the least discoverable bonus in the game, so it gets an
	-- explicit line rather than being buried in the luck breakdown.
	local parts = {}
	for typeName, progress in snapshot.typeProgress do
		if progress.owned >= progress.total then
			table.insert(parts, `<font color="#4ACD82">{typeName}</font>`)
		elseif progress.owned > 0 then
			table.insert(parts, `<font color="#9AA2B6">{typeName} {progress.owned}/{progress.total}</font>`)
		end
	end
	table.sort(parts)
	summary.Text = #parts > 0 and ("Type mastery:  " .. table.concat(parts, "   "))
		or "Type mastery: collect every creature of a type for +10% luck"
end

function Index.toggle()
	if window then
		window:toggle()
	end
end

return Index
